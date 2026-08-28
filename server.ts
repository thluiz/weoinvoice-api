/**
 * weoinvoice-api — lancamento de vendas POS no weoInvoice via HTTP puro.
 *
 * Emite documento fiscal real: nao ha sandbox e nao ha delete. Por isso o
 * servico e conservador por construcao — fila de uma venda por vez, carrinho
 * limpo antes de comecar, total conferido contra o que o site calculou,
 * rollback em qualquer erro, ledger de idempotencia e dry-run como default
 * de teste. Ver o plano em Obsidian para os riscos R1..R5.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { WeoClient, WeoError, round2, sameMoney, CENT } from "./weo"
import { Ledger } from "./ledger"
import { CatalogoStore, resolverPorNome } from "./catalogo"
import { tratarMcp, novaIdempotencyKey } from "./mcp"

const PORT = Number(process.env.PORT ?? 8007)
const API_KEY = process.env.WEOINVOICE_API_KEY ?? ""
const EMAIL = process.env.WEOINVOICE_EMAIL ?? ""
const PASSWORD = process.env.WEOINVOICE_PASSWORD ?? ""
const DIR = import.meta.dir
const SESSION_PATH = `${DIR}/session.json`
const LEDGER_PATH = `${DIR}/ledger.jsonl`
const AUDIT_DIR = `${DIR}/logs`

/**
 * Fail-closed: o parser do carrinho foi deduzido, nao confirmado contra o DOM.
 * Sem carrinho legivel nao ha como garantir que nao ha item orfao entrando na
 * fatura (R2), entao o finalize fica bloqueado ate o probe confirmar e a flag
 * ser setada no .env.
 */
const CART_VERIFIED = process.env.WEO_CART_READ_VERIFIED === "1"

/** Cliente de balcao. Fica so no .env: e um id interno da conta, nao pertence ao codigo. */
const CLIENTE_PADRAO = process.env.WEO_CLIENTE_PADRAO ?? ""
const GOSSIP_URL = process.env.GOSSIP_URL ?? "http://127.0.0.1:8080/api/gossip-gate/send"
const GOSSIP_KEY = process.env.GOSSIP_API_KEY ?? ""

if (!EMAIL || !PASSWORD) {
  console.error("[weoinvoice-api] faltam WEOINVOICE_EMAIL / WEOINVOICE_PASSWORD")
  process.exit(1)
}

// ------------------------------------------------------------------ logging

function log(msg: string, extra?: Record<string, unknown>) {
  const linha = { ts: new Date().toISOString(), msg, ...(extra ?? {}) }
  console.log(JSON.stringify(linha))
}

/** Trilha de auditoria: e documento fiscal, o rastro importa. */
async function audit(evento: string, dados: Record<string, unknown>) {
  try {
    await mkdir(AUDIT_DIR, { recursive: true })
    const dia = new Date().toISOString().slice(0, 10)
    await appendFile(
      `${AUDIT_DIR}/audit-${dia}.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), evento, ...dados }) + "\n",
      "utf8",
    )
  } catch (e) {
    log("falha ao gravar auditoria", { erro: String(e) })
  }
}

async function notificar(mensagem: string) {
  if (!GOSSIP_KEY) return
  try {
    await fetch(GOSSIP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": GOSSIP_KEY },
      body: JSON.stringify({ message: mensagem }),
    })
  } catch (e) {
    log("falha ao notificar via GossipGate", { erro: String(e) })
  }
}

// ------------------------------------------------------------------- estado

const client = new WeoClient({ email: EMAIL, password: PASSWORD, sessionPath: SESSION_PATH, log })
const ledger = new Ledger(LEDGER_PATH)

/** Catalogo em ficheiro: nao muda quase nunca e evita login so para consultar. */
const catalogo = new CatalogoStore(`${DIR}/catalogo.json`)

/** Fila: o carrinho e estado da sessao PHP, entao duas vendas em paralelo se misturariam. */
let fila: Promise<unknown> = Promise.resolve()
function enfileirar<T>(tarefa: () => Promise<T>): Promise<T> {
  const proxima = fila.then(tarefa, tarefa)
  fila = proxima.catch(() => {})
  return proxima
}

// ------------------------------------------------------------------ helpers

class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public extra?: unknown) {
    super(message)
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

function autorizado(req: Request) {
  if (!API_KEY) return false
  return req.headers.get("x-api-key") === API_KEY
}

/** Resolve nome de artigo para id, a partir do catalogo em ficheiro. */
async function resolverArtigo(item: { artigoId?: string; artigo?: string }): Promise<string> {
  if (item.artigoId) return String(item.artigoId).replace(/^product/i, "")
  if (!item.artigo) throw new ApiError("ARTIGO_DESCONHECIDO", "informe artigoId ou artigo")

  const { artigos } = await catalogo.obter(client)
  const { id, candidatos } = resolverPorNome(artigos, item.artigo)
  if (id) return id

  throw new ApiError(
    "ARTIGO_DESCONHECIDO",
    candidatos?.length
      ? `"${item.artigo}" e ambiguo no catalogo`
      : `artigo "${item.artigo}" nao esta no catalogo (POST /catalogo/refresh se foi criado agora)`,
    candidatos?.length ? 400 : 404,
    candidatos?.length ? candidatos : artigos.map((a) => a.nome),
  )
}

// -------------------------------------------------------------- fluxo venda

interface ItemReq {
  artigoId?: string
  artigo?: string
  precoUnitario: number
  quantidade?: number
  descontoPct?: number
}

interface SaleReq {
  itens: ItemReq[]
  clienteId?: string
  tipoDocumento?: "simplificada" | "factura"
  serie?: string
  dryRun?: boolean
  idempotencyKey?: string
}

function validarRequest(body: any): SaleReq {
  if (!body || typeof body !== "object") throw new ApiError("REQUEST", "body JSON obrigatorio")
  const itens = body.itens ?? (body.artigoId || body.artigo ? [body] : null)
  if (!Array.isArray(itens) || itens.length === 0) {
    throw new ApiError("REQUEST", "informe pelo menos um item em `itens`")
  }
  for (const [i, it] of itens.entries()) {
    const preco = Number(it.precoUnitario)
    if (!isFinite(preco) || preco <= 0) {
      throw new ApiError("REQUEST", `item ${i}: precoUnitario deve ser numero positivo`)
    }
    const qtd = it.quantidade === undefined ? 1 : Number(it.quantidade)
    if (!Number.isInteger(qtd) || qtd <= 0) {
      throw new ApiError("REQUEST", `item ${i}: quantidade deve ser inteiro positivo`)
    }
    const desc = it.descontoPct === undefined ? 0 : Number(it.descontoPct)
    if (!isFinite(desc) || desc < 0 || desc >= 100) {
      throw new ApiError("REQUEST", `item ${i}: descontoPct deve estar entre 0 e 99`)
    }
  }
  const tipo = body.tipoDocumento ?? "simplificada"
  if (tipo !== "simplificada" && tipo !== "factura") {
    throw new ApiError("REQUEST", 'tipoDocumento deve ser "simplificada" ou "factura"')
  }
  const dryRun = body.dryRun === true
  if (!dryRun && !body.idempotencyKey) {
    throw new ApiError("REQUEST", "idempotencyKey e obrigatoria quando dryRun=false")
  }
  return { ...body, itens, tipoDocumento: tipo, dryRun }
}

async function executarVenda(req: SaleReq) {
  const dryRun = req.dryRun === true
  const key = req.idempotencyKey

  // 1. idempotencia: decide antes de tocar no weoInvoice
  if (!dryRun && key) {
    await ledger.load()
    const anterior = ledger.get(key)
    if (anterior?.state === "done") {
      log("idempotencyKey repetida, devolvendo resultado gravado", { key })
      return { ...(anterior.resultado as object), repetida: true }
    }
    if (anterior?.state === "finalizing") {
      throw new ApiError(
        "AMBIGUO_VERIFICAR_LISTAGEM",
        `a chave ${key} ficou presa em "finalizing": uma emissao anterior pode ter sido concluida no weoInvoice. ` +
          `Confira GET /faturas antes de tentar de novo com outra chave.`,
        409,
        { desde: anterior.at, total: anterior.total },
      )
    }
  }

  const clienteId = req.clienteId ?? CLIENTE_PADRAO
  if (!clienteId) {
    throw new ApiError(
      "REQUEST",
      "informe clienteId no pedido ou configure WEO_CLIENTE_PADRAO no .env",
    )
  }

  if (!dryRun && !CART_VERIFIED) {
    throw new ApiError(
      "CARRINHO_NAO_VERIFICADO",
      "emissao real bloqueada: o parser do carrinho ainda nao foi confirmado contra o DOM real " +
        "(rode `bun run probe.ts` e sete WEO_CART_READ_VERIFIED=1). dryRun=true funciona normalmente.",
      503,
    )
  }

  await client.ensureSession()

  // 2. carrinho limpo antes de comecar.
  // O carrinho e do utilizador, nao da sessao: sobrevive a reload e a novo login.
  // Um item deixado por uma venda anterior (ou pela UI do browser) entraria nesta
  // fatura sem aviso.
  const antes = await client.readCart()
  if (antes.itens.length) {
    log("carrinho tinha itens de antes, limpando", { itens: antes.itens.map((r) => r.itemId), total: antes.total })
    await audit("carrinho_sujo", { itens: antes.itens, total: antes.total })
    const { falhas } = await client.removeItems(antes.itens.map((r) => r.itemId))
    if (falhas.length) {
      throw new ApiError("CARRINHO_SUJO", `nao consegui limpar o carrinho (itens ${falhas.join(", ")})`, 409)
    }
    const conferido = await client.readCart()
    if (conferido.itens.length) {
      throw new ApiError("CARRINHO_SUJO", `carrinho ainda tem ${conferido.itens.length} itens apos a limpeza`, 409)
    }
  }

  // 3. montar o carrinho, conferindo cada subtotal contra o esperado
  const adicionados: string[] = []
  const linhas: any[] = []
  let total = 0

  try {
    for (const item of req.itens) {
      const artigoId = await resolverArtigo(item)
      const quantidade = item.quantidade ?? 1
      const descontoPct = item.descontoPct ?? 0

      const add = await client.addProduct(artigoId)
      adicionados.push(add.itemId)

      const upd = await client.setItem(add.itemId, quantidade, item.precoUnitario, descontoPct)
      total = round2(total + upd.subtotal)
      linhas.push({
        artigoId,
        nome: add.nome,
        quantidade: upd.quantidade,
        precoUnitario: upd.preco,
        descontoPct,
        subtotal: upd.subtotal,
        taxa: upd.taxa,
      })
    }

    // 4. o carrinho tem exatamente o que colocamos, nem a mais nem a menos
    const conferencia = await client.readCart()
    if (conferencia.itens.length !== adicionados.length) {
      throw new ApiError(
        "TOTAL_DIVERGENTE",
        `carrinho tem ${conferencia.itens.length} itens mas foram adicionados ${adicionados.length}`,
        409,
        { noCarrinho: conferencia.itens.map((c) => c.itemId), adicionados },
      )
    }

    const esperado = round2(
      req.itens.reduce(
        (s, i) => s + (i.quantidade ?? 1) * i.precoUnitario * (1 - (i.descontoPct ?? 0) / 100),
        0,
      ),
    )
    const tolerancia = CENT * req.itens.length // um cetimo de arredondamento por linha

    // A soma das linhas bate com o pedido?
    if (!sameMoney(total, esperado, tolerancia)) {
      throw new ApiError("TOTAL_DIVERGENTE", `soma das linhas ${total} difere do pedido ${esperado}`, 409)
    }

    // E o total que o SERVIDOR calcula para o carrinho? Esta e a verificacao que
    // vale: e o valor que vai para o documento fiscal, e apanha tudo o que as
    // outras nao apanham (item orfao, preco mal interpretado, linha duplicada).
    if (!sameMoney(conferencia.total, esperado, tolerancia)) {
      throw new ApiError(
        "TOTAL_DIVERGENTE",
        `o carrinho no servidor totaliza ${conferencia.total.toFixed(2)} mas o pedido e ${esperado.toFixed(2)}`,
        409,
        { totalServidor: conferencia.total, esperado, linhas },
      )
    }

    // 5. dry-run para por aqui: desmonta o carrinho e devolve o preview
    if (dryRun) {
      await client.removeItems(adicionados)
      const sobra = await client.readCart()
      return {
        sucesso: true,
        dryRun: true,
        total,
        totalNoServidor: conferencia.total,
        itens: linhas,
        clienteId,
        tipoDocumento: req.tipoDocumento,
        serie: req.serie ?? (await client.getSerie()),
        formatoDecimal: client.priceFormat,
        carrinhoLimpoDepois: sobra.itens.length === 0,
      }
    }
  } catch (e) {
    // rollback best-effort: nao deixar item orfao pra proxima venda
    if (adicionados.length) {
      const { falhas } = await client.removeItems(adicionados)
      if (falhas.length) {
        await audit("rollback_incompleto", { itens: falhas })
        await notificar(`⚠️ weoInvoice: rollback incompleto, itens ${falhas.join(", ")} ficaram no carrinho`)
      }
    }
    throw e
  }

  // 6. emissao real
  const serie = req.serie ?? (await client.getSerie())
  const tipoDocumento = req.tipoDocumento!

  if (key) await ledger.markFinalizing(key, total)
  await audit("finalize_inicio", { key, total, clienteId, tipoDocumento, serie, itens: linhas })

  let idInterno: string
  try {
    idInterno = await client.finalize({ clienteId, tipoDocumento, serie })
  } catch (e) {
    if (e instanceof WeoError && e.code === "FINALIZE_REJEITADO") {
      // o site recusou explicitamente: nada foi emitido, chave liberada
      if (key) await ledger.markFailed(key, e.message)
      await audit("finalize_recusado", { key, erro: e.message })
      await client.removeItems(adicionados)
      throw new ApiError("FINALIZE_REJEITADO", e.message, 422, e.detail)
    }

    // erro de rede/timeout: a fatura PODE ter sido criada. Reconcilia antes de responder.
    log("finalize falhou de forma ambigua, tentando reconciliar", { erro: String(e) })
    const achada = await reconciliar(total)
    if (achada) {
      const resultado = {
        sucesso: true,
        numero: achada.numero,
        idInterno: null,
        total,
        itens: linhas,
        reconciliada: true,
      }
      if (key) await ledger.markDone(key, resultado)
      await audit("finalize_reconciliado", { key, numero: achada.numero, total })
      await notificar(`✅ weoInvoice ${achada.numero} — €${total.toFixed(2)} (confirmada por reconciliação)`)
      return resultado
    }
    await audit("finalize_ambiguo", { key, erro: String(e), total })
    await notificar(`🚨 weoInvoice: finalize ambíguo (€${total.toFixed(2)}). Conferir a listagem manualmente.`)
    throw new ApiError(
      "AMBIGUO_VERIFICAR_LISTAGEM",
      `o finalize falhou sem resposta conclusiva e nao achei fatura correspondente na listagem. ` +
        `Confira manualmente antes de repetir: ${String(e)}`,
      502,
    )
  }

  // 7. o numero visivel (2026/12) so aparece na listagem
  let numero: string | null = null
  try {
    const lista = await client.listInvoices(5)
    numero = lista[0]?.numero ?? null
  } catch (e) {
    log("emissao ok mas nao consegui ler o numero na listagem", { erro: String(e) })
  }

  const resultado = {
    sucesso: true,
    dryRun: false,
    numero,
    idInterno,
    total,
    itens: linhas,
    clienteId,
    tipoDocumento,
    serie,
    pdfUrl: client.invoicePdfUrl(idInterno),
  }

  if (key) await ledger.markDone(key, resultado)
  await audit("finalize_ok", { key, numero, idInterno, total })
  await notificar(`✅ weoInvoice ${numero ?? idInterno} — €${total.toFixed(2)}`)
  return resultado
}

/** R1: apos falha ambigua, procura na listagem uma fatura com o total esperado. */
async function reconciliar(total: number) {
  try {
    const lista = await client.listInvoices(5)
    return lista.find((f) => f.total !== undefined && sameMoney(f.total, total)) ?? null
  } catch (e) {
    log("reconciliacao falhou", { erro: String(e) })
    return null
  }
}

// -------------------------------------------------------------------- rotas

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const rota = url.pathname.replace(/\/+$/, "") || "/"

    if (rota === "/health") {
      const temSessao = await client.loadSession()
      const cat = await catalogo.carregar().catch(() => null)
      return json({
        ok: true,
        servico: "weoinvoice-api",
        porta: PORT,
        sessaoEmCache: temSessao,
        carrinhoVerificado: CART_VERIFIED,
        emissaoRealHabilitada: CART_VERIFIED,
        formatoDecimal: client.priceFormat,
        catalogo: cat
          ? { atualizadoEm: cat.atualizadoEm, artigos: cat.artigos.length, clientes: cat.clientes.length }
          : null,
      })
    }

    if (!autorizado(req)) {
      return json({ sucesso: false, erro: "NAO_AUTORIZADO", mensagem: "X-Api-Key ausente ou invalida" }, 401)
    }

    try {
      // Le do ficheiro: nao faz login, nao derruba a sessao do browser.
      if (rota === "/catalogo" && req.method === "GET") {
        const c = await catalogo.obter(client)
        return json({ sucesso: true, ...c })
      }

      // Vai ao weoInvoice e reescreve o ficheiro. Diz o que mudou.
      if (rota === "/catalogo/refresh" && req.method === "POST") {
        const { catalogo: c, mudancas } = await catalogo.atualizar(client)
        log("catalogo actualizado", { ...mudancas, artigos: c.artigos.length, clientes: c.clientes.length })
        await audit("catalogo_refresh", { ...mudancas })
        if (mudancas.artigosNovos.length || mudancas.artigosRemovidos.length) {
          await notificar(
            `📦 weoInvoice catálogo: ${mudancas.artigosNovos.length} artigo(s) novo(s), ` +
              `${mudancas.artigosRemovidos.length} removido(s)`,
          )
        }
        return json({ sucesso: true, mudancas, atualizadoEm: c.atualizadoEm, artigos: c.artigos, clientes: c.clientes })
      }

      if (rota === "/faturas" && req.method === "GET") {
        const n = Math.min(Number(url.searchParams.get("ultimas") ?? 10) || 10, 50)
        await client.ensureSession()
        return json({ sucesso: true, faturas: await client.listInvoices(n) })
      }

      // MCP sobre HTTP, mesmo padrao do gossip-gate. Reusa as funcoes da REST.
      if (rota === "/mcp" && req.method === "POST") {
        const msg = await req.json().catch(() => null)
        const resposta = await tratarMcp(msg, {
          lancarNota: async (args) => {
            const pedido = validarRequest({
              ...args,
              ...(args?.dryRun ? {} : { idempotencyKey: args?.idempotencyKey ?? novaIdempotencyKey() }),
            })
            return enfileirar(() => executarVenda(pedido))
          },
          catalogo: () => catalogo.obter(client),
          atualizarCatalogo: async () => {
            const { catalogo: c, mudancas } = await catalogo.atualizar(client)
            await audit("catalogo_refresh", { ...mudancas, origem: "mcp" })
            return { mudancas, atualizadoEm: c.atualizadoEm, artigos: c.artigos, clientes: c.clientes }
          },
          ultimasFaturas: async (n) => {
            await client.ensureSession()
            return { faturas: await client.listInvoices(Math.min(n || 10, 50)) }
          },
        })
        return resposta === null ? new Response(null, { status: 202 }) : json(resposta)
      }

      if (rota === "/pos/sale" && req.method === "POST") {
        const body = await req.json().catch(() => null)
        const pedido = validarRequest(body)
        const resultado = await enfileirar(() => executarVenda(pedido))
        return json(resultado)
      }

      return json({ sucesso: false, erro: "ROTA_DESCONHECIDA", mensagem: `${req.method} ${rota}` }, 404)
    } catch (e) {
      if (e instanceof ApiError) {
        return json({ sucesso: false, erro: e.code, mensagem: e.message, detalhe: e.extra }, e.status)
      }
      if (e instanceof WeoError) {
        if (e.code === "PARSE") {
          await notificar(`🚨 weoInvoice: falha de parse (${e.message}). O site pode ter mudado.`)
        }
        return json({ sucesso: false, erro: e.code, mensagem: e.message }, 502)
      }
      log("erro nao tratado", { erro: String(e) })
      return json({ sucesso: false, erro: "INTERNO", mensagem: String(e) }, 500)
    }
  },
})

log("weoinvoice-api no ar", {
  porta: server.port,
  emissaoRealHabilitada: CART_VERIFIED,
  apiKeyConfigurada: Boolean(API_KEY),
})
