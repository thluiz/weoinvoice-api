/**
 * Cliente HTTP do weoInvoice (sem browser).
 *
 * Fluxo validado em 2026-08-28: login por form + cookie PHPSESSID.
 * As respostas AJAX sao texto pipe-separated, nao JSON.
 */

import { existsSync } from "node:fs"
import { readFile, writeFile, chmod } from "node:fs/promises"

export const BASE = "https://www.weoinvoice.com"
const UA = "Mozilla/5.0 (weoinvoice-api)"
const POS_REFERER = `${BASE}/admin.php?module=invoice&func=pos`
const LOGIN_REFERER = `${BASE}/admin.php?module=user&func=login`

export type Jar = Record<string, string>

export class WeoError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message)
    this.name = "WeoError"
  }
}

/** Numeros vem do site em formato PT (1.234,56) ou US (1234.56). Aceita os dois. */
export function parseNum(raw: string): number {
  const s = String(raw).replace(/[^\d.,-]/g, "").trim()
  if (!s) return NaN
  const lastDot = s.lastIndexOf(".")
  const lastComma = s.lastIndexOf(",")
  let out = s
  if (lastDot > -1 && lastComma > -1) {
    const decIdx = Math.max(lastDot, lastComma)
    const decSep = s[decIdx]!
    const thouSep = decSep === "." ? "," : "."
    out = s.split(thouSep).join("")
    out = out.slice(0, out.lastIndexOf(decSep)) + "." + out.slice(out.lastIndexOf(decSep) + 1)
  } else if (lastComma > -1) {
    out = s.length - lastComma - 1 <= 2 ? s.replace(",", ".") : s.split(",").join("")
  }
  return Number(out)
}

/**
 * Tolerancia de um cetimo por linha.
 *
 * A conferencia de total existe pra pegar erro grosseiro — separador decimal
 * lido errado (15,50 virando 1550), item orfao inflando a fatura, site
 * ignorando o preco enviado. Nao existe pra arbitrar politica de arredondamento:
 * se o weoInvoice arredonda meio cetimo pra cima e nos pra baixo, abortar seria
 * falso positivo. Um cetimo por linha absorve isso e continua detectando
 * qualquer divergencia que importe.
 */
export const CENT = 0.011
export const sameMoney = (a: number, b: number, tolerancia = CENT) => Math.abs(a - b) < tolerancia

/** Arredonda pra cetimos compensando a representacao binaria (1.005 e 1.00499... em float). */
export const round2 = (n: number) => Math.round((n + Number.EPSILON * Math.sign(n)) * 100) / 100

function parseSetCookie(headers: Headers): Jar {
  const jar: Jar = {}
  for (const line of headers.getSetCookie?.() ?? []) {
    const first = line.split(";")[0] ?? ""
    const eq = first.indexOf("=")
    if (eq > -1) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
  }
  return jar
}

const cookieHeader = (jar: Jar) =>
  Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ")

/**
 * O site nao declara charset. As paginas HTML vem em windows-1252 e as respostas
 * AJAX em UTF-8, entao decidir pelo conteudo: se a leitura como UTF-8 produzir
 * caracteres de substituicao, era latin. Sem isto, "TERRARIO" chega partido e o
 * match de artigo por nome falha.
 */
async function decodeBody(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer())
  const utf8 = new TextDecoder("utf-8").decode(bytes)
  if (!utf8.includes("�")) return utf8
  return new TextDecoder("windows-1252").decode(bytes)
}

/** Marcador de que o servidor devolveu a pagina de login no lugar do conteudo. */
function looksLikeLoginPage(text: string) {
  return /name=["']password["']/i.test(text) && /func=submitlogin/i.test(text)
}

export interface ClientOpts {
  email: string
  password: string
  sessionPath: string
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

export interface CartItem {
  itemId: string
  nome?: string
  subtotal?: number
}

export interface CartSnapshot {
  itens: CartItem[]
  /** Total calculado pelo servidor. E a unica fonte confiavel do valor da fatura. */
  total: number
}

export interface AddResult {
  itemId: string
  nome: string
  preco: number
  taxa: string
}

export interface UpdateResult {
  quantidade: number
  preco: number
  subtotal: number
  taxa: string
  desconto: number
}

export class WeoClient {
  private jar: Jar = {}
  private loggedIn = false
  /** Formato decimal aceito pelo site, descoberto em runtime e memorizado. */
  private priceStyle: "dot" | "comma" | null = null
  private log: (msg: string, extra?: Record<string, unknown>) => void

  constructor(private opts: ClientOpts) {
    this.log = opts.log ?? (() => {})
  }

  get priceFormat() {
    return this.priceStyle
  }

  // ---------------------------------------------------------------- sessao

  async loadSession(): Promise<boolean> {
    if (!existsSync(this.opts.sessionPath)) return false
    try {
      const raw = JSON.parse(await readFile(this.opts.sessionPath, "utf8"))
      if (raw?.jar?.PHPSESSID) {
        this.jar = raw.jar
        this.loggedIn = true
        return true
      }
    } catch (e) {
      this.log("sessao em cache ilegivel, ignorando", { erro: String(e) })
    }
    return false
  }

  private async saveSession() {
    await writeFile(this.opts.sessionPath, JSON.stringify({ jar: this.jar, savedAt: new Date().toISOString() }), "utf8")
    await chmod(this.opts.sessionPath, 0o600)
  }

  /** GET barato numa pagina autenticada. Nao renova nada, so responde se a sessao vale. */
  async isSessionValid(): Promise<boolean> {
    if (!this.jar.PHPSESSID) return false
    try {
      const res = await fetch(`${BASE}/admin.php?module=invoice&func=list`, {
        headers: { "User-Agent": UA, Cookie: cookieHeader(this.jar) },
        redirect: "manual",
      })
      if (res.status >= 300 && res.status < 400) return false
      const text = await res.text()
      return !looksLikeLoginPage(text)
    } catch (e) {
      this.log("falha ao validar sessao", { erro: String(e) })
      return false
    }
  }

  async login(): Promise<void> {
    const getLogin = await fetch(`${BASE}/admin.php?module=user&func=login`, {
      headers: { "User-Agent": UA },
      redirect: "manual",
    })
    this.jar = parseSetCookie(getLogin.headers)
    this.jar.js_enabled = "1"

    const body = new URLSearchParams({
      email: this.opts.email,
      password: this.opts.password,
      submit: "Entrar >",
    }).toString()

    const res = await fetch(`${BASE}/admin.php?type=adminform&module=user&func=submitlogin`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(this.jar),
        Referer: LOGIN_REFERER,
        Origin: BASE,
      },
      body,
      redirect: "manual",
    })

    this.jar = { ...this.jar, ...parseSetCookie(res.headers) }
    const location = res.headers.get("location") ?? ""

    if (res.status !== 302 || !location.includes("module=invoice")) {
      throw new WeoError("SESSAO", `login recusado (status ${res.status}, location "${location}")`)
    }
    this.loggedIn = true
    this.priceStyle = null // sessao nova, re-descobrir
    await this.saveSession()
    this.log("login efetuado", { phpsessid: this.jar.PHPSESSID?.slice(0, 6) + "..." })
  }

  /** Garante sessao utilizavel reaproveitando o cache. Devolve true se precisou relogar. */
  async ensureSession(): Promise<boolean> {
    if (!this.loggedIn) await this.loadSession()
    if (this.loggedIn && (await this.isSessionValid())) return false
    await this.login()
    return true
  }

  // ------------------------------------------------------------- transporte

  /** Publico para o probe.ts poder sondar endpoints candidatos sem furar o encapsulamento. */
  async post(func: string, body: string, module = "invoice"): Promise<string> {
    const url = `${BASE}/admin.php?module=${module}&type=adminform&func=${func}`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(this.jar),
        Referer: POS_REFERER,
        Origin: BASE,
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    })
    const text = await decodeBody(res)
    if (looksLikeLoginPage(text)) {
      this.loggedIn = false
      throw new WeoError("SESSAO", `sessao expirou durante ${func}`)
    }
    if (!res.ok) {
      throw new WeoError("PARSE", `${func} respondeu HTTP ${res.status}`, text.slice(0, 500))
    }
    return text
  }

  async get(qs: string): Promise<string> {
    const res = await fetch(`${BASE}/admin.php?${qs}`, {
      headers: { "User-Agent": UA, Cookie: cookieHeader(this.jar) },
      redirect: "manual",
    })
    const text = await decodeBody(res)
    if (res.status >= 300 && res.status < 400) {
      this.loggedIn = false
      throw new WeoError("SESSAO", `redirect ao buscar ${qs} (sessao caiu)`)
    }
    if (looksLikeLoginPage(text)) {
      this.loggedIn = false
      throw new WeoError("SESSAO", `pagina de login ao buscar ${qs}`)
    }
    return text
  }

  // --------------------------------------------------------------- carrinho

  /**
   * Le o carrinho POS a partir da pagina servida.
   *
   * O carrinho e do UTILIZADOR, nao da sessao: sobrevive a reload e a novo login
   * (confirmado por sonda em 2026-08-28). Um item orfao de uma venda que falhou
   * entraria na proxima fatura, por isso ler isto antes de cada venda nao e
   * opcional. Ver R2 no plano.
   *
   * A pagina traz tres coisas independentes — a contagem em `num_products`, os
   * ids `itemNNN`, e o total calculado PELO SERVIDOR. Divergencia entre elas e
   * erro, nao detalhe: significa que a pagina mudou.
   */
  async readCart(): Promise<CartSnapshot> {
    const html = await this.get("module=invoice&func=pos")
    return parseCartSnapshot(html)
  }

  async addProduct(productId: string): Promise<AddResult> {
    const text = await this.post("ajax_addposinvoiceproduct", `id=${encodeURIComponent(productId)}`)
    const parts = text.split("||")
    const itemId = (parts[0] ?? "").trim()
    if (!itemId || !/^\d+$/.test(itemId)) {
      throw new WeoError("PARSE", `resposta inesperada ao adicionar artigo ${productId}`, text.slice(0, 300))
    }
    return {
      itemId,
      nome: (parts[1] ?? "").trim(),
      preco: parseNum(parts[2] ?? ""),
      taxa: (parts[3] ?? "").trim(),
    }
  }

  async removeItem(itemId: string): Promise<void> {
    await this.post("ajax_removeposinvoiceproduct", `id=${encodeURIComponent(itemId)}`)
  }

  /** Remove todos os itens informados, sem deixar erro individual abortar o resto. */
  async removeItems(itemIds: string[]): Promise<{ removidos: string[]; falhas: string[] }> {
    const removidos: string[] = []
    const falhas: string[] = []
    for (const id of itemIds) {
      try {
        await this.removeItem(id)
        removidos.push(id)
      } catch (e) {
        falhas.push(id)
        this.log("falha ao remover item do carrinho", { itemId: id, erro: String(e) })
      }
    }
    return { removidos, falhas }
  }

  private fmtPrice(v: number, style: "dot" | "comma") {
    const s = v.toFixed(2)
    return style === "dot" ? s : s.replace(".", ",")
  }

  private async sendUpdate(
    itemId: string,
    quantidade: number,
    preco: number,
    descontoPct: number,
    style: "dot" | "comma",
  ): Promise<UpdateResult> {
    const body =
      `id=${encodeURIComponent(itemId)}` +
      `&quantity=${quantidade}` +
      `&price=${encodeURIComponent(this.fmtPrice(preco, style))}` +
      `&discount=${encodeURIComponent(this.fmtPrice(descontoPct, style))}`
    const text = await this.post("ajax_updateposinvoiceproduct", body)
    const p = text.split("|")
    if (p.length < 3) {
      throw new WeoError("PARSE", `resposta inesperada ao ajustar item ${itemId}`, text.slice(0, 300))
    }
    return {
      quantidade: parseNum(p[0] ?? ""),
      preco: parseNum(p[1] ?? ""),
      subtotal: parseNum(p[2] ?? ""),
      taxa: (p[3] ?? "").trim(),
      desconto: parseNum(p[4] ?? ""),
    }
  }

  /**
   * Ajusta quantidade/preco/desconto e CONFERE o subtotal devolvido pelo site
   * contra o esperado. Serve pra duas coisas ao mesmo tempo: descobrir se o
   * site quer ponto ou virgula como separador decimal, e garantir que o valor
   * que vai pro documento fiscal e o que pedimos (R2).
   */
  async setItem(itemId: string, quantidade: number, preco: number, descontoPct: number): Promise<UpdateResult> {
    const esperado = round2(quantidade * preco * (1 - descontoPct / 100))
    // Virgula primeiro: em 2026-08-28 confirmou-se que "10.00" e lido como 1000
    // (o ponto vira separador de milhar). A ordem so afeta o numero de tentativas;
    // quem decide e a conferencia do subtotal abaixo.
    const ordem: Array<"dot" | "comma"> = this.priceStyle ? [this.priceStyle] : ["comma", "dot"]
    let ultimo: UpdateResult | null = null

    for (const style of ordem) {
      const r = await this.sendUpdate(itemId, quantidade, preco, descontoPct, style)
      ultimo = r
      if (sameMoney(r.subtotal, esperado)) {
        if (this.priceStyle !== style) {
          this.priceStyle = style
          this.log("formato decimal aceito pelo site", { style })
        }
        return r
      }
      this.log("subtotal divergente, tentando outro formato decimal", {
        style, esperado, recebido: r.subtotal,
      })
    }

    throw new WeoError(
      "TOTAL_DIVERGENTE",
      `subtotal do item ${itemId} nao bate: esperado ${esperado.toFixed(2)}, site devolveu ${ultimo?.subtotal}`,
      ultimo,
    )
  }

  // -------------------------------------------------------------- finalizar

  async finalize(params: {
    clienteId: string
    tipoDocumento: "simplificada" | "factura"
    serie: string
  }): Promise<string> {
    const simplificada = params.tipoDocumento === "simplificada"
    const body = new URLSearchParams({
      pos_client: params.clienteId,
      pos_type_invoice: simplificada ? "undefined" : "checked",
      pos_type_invoice_receipt: "undefined",
      pos_type_receipt: simplificada ? "checked" : "undefined",
      pos_serie: params.serie,
      pos_payment: "undefined",
      pos_new_client: "",
      pos_new_nif: "",
    }).toString()

    const text = await this.post("ajax_addposinvoice", body)
    const [code, payload] = text.split("|")
    if ((code ?? "").trim() !== "200") {
      throw new WeoError(
        "FINALIZE_REJEITADO",
        `weoInvoice recusou a emissao (codigo ${code}): ${payload ?? "sem mensagem"}`,
        text.slice(0, 300),
      )
    }
    const id = (payload ?? "").trim()
    if (!id) throw new WeoError("PARSE", "finalize devolveu 200 sem id de documento", text.slice(0, 300))
    return id
  }

  // ----------------------------------------------------------- consultas

  async getClients(): Promise<Array<{ id: string; nome: string; nif?: string }>> {
    const text = await this.post("ajax_getclients", "", "client")
    return parseClientsResponse(text)
  }

  async getPosProducts(): Promise<Array<{ id: string; nome: string; preco?: number }>> {
    const html = await this.get("module=invoice&func=pos")
    return parsePosProductsHtml(html)
  }

  /** Serie corrente configurada no POS. Nunca cai pro ano anterior em silencio. */
  async getSerie(): Promise<string> {
    const html = await this.get("module=invoice&func=pos")
    const serie = parseSerieHtml(html)
    if (!serie) throw new WeoError("PARSE", "nao consegui determinar a serie corrente na pagina POS")
    return serie
  }

  async listInvoices(limite = 10): Promise<FaturaLinha[]> {
    const html = await this.get("module=invoice&func=list")
    return parseInvoiceListHtml(html).slice(0, limite)
  }

  /**
   * Documentos emitidos numa data (YYYY-MM-DD).
   *
   * A listagem nao aceita filtro por data no servidor (so por cliente, tipo e
   * palavra-chave), mas vem ordenada da mais recente para a mais antiga. Entao
   * percorre-se as paginas e para-se assim que aparece uma data anterior a
   * procurada, o que normalmente resolve na primeira pagina.
   *
   * O paginador do site nao e de confiar: se uma pagina nao trouxer documento
   * novo, para-se, para nao entrar em ciclo.
   */
  async listInvoicesByDate(data: string, maxPaginas = 10): Promise<FaturaLinha[]> {
    const achadas: FaturaLinha[] = []
    const vistos = new Set<string>()

    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const qs =
        `module=invoice&func=list&page=${pagina}` +
        `&order=desc&invoicetype=0&clientid=0&keyword=`
      const linhas = parseInvoiceListHtml(await this.get(qs))

      let novas = 0
      let passouDoDia = false

      for (const l of linhas) {
        if (vistos.has(l.numero)) continue
        vistos.add(l.numero)
        novas++
        if (!l.data) continue
        if (l.data === data) achadas.push(l)
        else if (l.data < data) passouDoDia = true
      }

      if (novas === 0) break // paginador nao avancou
      if (passouDoDia) break // ja passamos para dias anteriores
    }

    return achadas
  }

  invoicePdfUrl(idInterno: string) {
    return `${BASE}/admin.php?module=invoice&func=print&id=${encodeURIComponent(idInterno)}&original=true`
  }
}

// ---------------------------------------------------------------- parsers
// Isolados aqui de proposito: sao a parte fragil (R5). Todos falham alto em vez
// de chutar, e sao os alvos do probe.mjs.

/** Itens do carrinho: a pagina renderiza um `id="itemNNN"` por linha. */
export function parseCartHtml(html: string): CartItem[] {
  const ids = [...html.matchAll(/id=["']item(\d+)["']/gi)].map((m) => m[1]!)
  return [...new Set(ids)].map((itemId) => ({ itemId }))
}

/** Contador que a pagina mantem em `num_products`. */
export function parseCartCount(html: string): number | null {
  const v = html.match(/id=["']num_products["'][^>]*value=["'](\d+)["']/i)?.[1]
  return v === undefined ? null : Number(v)
}

/** Total do carrinho calculado pelo servidor (rodape do POS). */
export function parseCartTotal(html: string): number | null {
  const m = html.match(/pos-invoice-products-total-value[^>]*>\s*<span>([^<]*)<\/span>/i)
  if (!m) return null
  const n = parseNum(m[1] ?? "")
  return isNaN(n) ? null : n
}

/**
 * Junta os tres sinais e exige que concordem.
 *
 * Se a contagem nao bater com o numero de ids, ou se o total nao for legivel,
 * e porque a pagina mudou — e ai a leitura do carrinho deixa de ser confiavel,
 * que e precisamente a condicao em que nao se pode emitir.
 */
export function parseCartSnapshot(html: string): CartSnapshot {
  const itens = parseCartHtml(html)
  const count = parseCartCount(html)
  const total = parseCartTotal(html)

  if (count === null) {
    throw new WeoError("PARSE", "nao encontrei num_products na pagina POS")
  }
  if (total === null) {
    throw new WeoError("PARSE", "nao consegui ler o total do carrinho na pagina POS")
  }
  if (count !== itens.length) {
    throw new WeoError(
      "PARSE",
      `carrinho inconsistente: num_products=${count} mas ${itens.length} ids "itemNNN" no HTML`,
      { ids: itens.map((i) => i.itemId) },
    )
  }
  return { itens, total }
}

/**
 * Resposta de ajax_getclients: registos separados por `|`, campos por `%%`.
 * Campos observados: [id, ?, nome, NIF].
 */
export function parseClientsResponse(text: string): Array<{ id: string; nome: string; nif?: string }> {
  const out: Array<{ id: string; nome: string; nif?: string }> = []
  for (const bruto of text.split("|")) {
    const reg = bruto.trim()
    if (!reg) continue
    const campos = reg.split("%%").map((c) => c.trim())
    const id = campos[0]
    const nome = campos[2]
    const nif = campos[3]
    if (!id || !/^\d+$/.test(id) || !nome) continue
    out.push({ id, nome, ...(nif ? { nif } : {}) })
  }
  return out
}

/** PROBE: os artigos do POS aparecem como elementos com id "productNNNNN". */
export function parsePosProductsHtml(html: string): Array<{ id: string; nome: string; preco?: number }> {
  const out = new Map<string, { id: string; nome: string; preco?: number }>()
  const re = /id=["']product(\d+)["'][^>]*>([\s\S]{0,400}?)<\/(?:div|li|a|td)>/gi
  for (const m of html.matchAll(re)) {
    const id = m[1]!
    const bloco = m[2] ?? ""
    const nome = bloco
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    if (!out.has(id)) out.set(id, { id, nome })
  }
  return [...out.values()]
}

/**
 * Serie corrente.
 *
 * O `<select id="pos_serie">` vem vazio no HTML — o JS copia para dentro dele o
 * conteudo de `#pos-serie-standard`, e o `ajax_getseries` esta comentado no
 * pos.js. Logo, a fonte e o bloco escondido, cuja primeira option e o ano
 * corrente. Devolve null (erro alto) se nao achar: nunca assumir o ano.
 */
export function parseSerieHtml(html: string): string | null {
  const bloco = html.match(/id=["']pos-serie-standard["'][^>]*>([\s\S]{0,2000}?)<\/(?:div|select|span)>/i)?.[1]
  if (!bloco) return null
  const selecionada = bloco.match(/<option[^>]*selected[^>]*value=["']([^"']+)["']/i)?.[1]
    ?? bloco.match(/<option[^>]*value=["']([^"']+)["'][^>]*selected/i)?.[1]
  if (selecionada) return selecionada.trim()
  const primeira = bloco.match(/<option[^>]*value=["']([^"']+)["']/i)?.[1]
  return primeira ? primeira.trim() : null
}

export interface FaturaLinha {
  numero: string
  tipo?: string
  cliente?: string
  total?: number
  data?: string
  estado?: string
  pago?: string
}

const semAcento = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

function celulasDe(tr: string): string[] {
  return [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
    (m[1] ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
  )
}

/**
 * Posicao de cada coluna, lida do cabecalho da tabela.
 *
 * Ancorar no cabecalho em vez de adivinhar por formato: antes, "Factura
 * Simplificada" era apanhado como nome do cliente porque era a primeira celula
 * de texto da linha.
 */
function mapearColunas(celulas: string[]): Record<string, number> | null {
  const idx: Record<string, number> = {}
  celulas.forEach((c, i) => {
    const n = semAcento(c)
    if (n === "tipo") idx.tipo = i
    else if (n === "numero") idx.numero = i
    else if (n === "cliente") idx.cliente = i
    else if (n === "valor") idx.total = i
    else if (n === "emissao") idx.data = i
    else if (n === "estado") idx.estado = i
    else if (n === "pago") idx.pago = i
  })
  return idx.numero !== undefined && idx.data !== undefined ? idx : null
}

/** Linhas da listagem de documentos. Usado pela reconciliacao (R1) e pelo fecho do dia. */
export function parseInvoiceListHtml(html: string): FaturaLinha[] {
  const linhas = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  let col: Record<string, number> | null = null
  const out: FaturaLinha[] = []

  for (const tr of linhas) {
    const celulas = celulasDe(tr)
    if (!celulas.length) continue

    if (!col) {
      col = mapearColunas(celulas)
      if (col) continue // era a linha de cabecalho
    }
    if (!col) continue

    const numero = celulas[col.numero!]
    if (!numero || !/^\d{4}\/\d+$/.test(numero)) continue

    const valor = col.total !== undefined ? parseNum(celulas[col.total] ?? "") : NaN
    out.push({
      numero,
      ...(col.tipo !== undefined && celulas[col.tipo] ? { tipo: celulas[col.tipo] } : {}),
      ...(col.cliente !== undefined && celulas[col.cliente] ? { cliente: celulas[col.cliente] } : {}),
      ...(isNaN(valor) ? {} : { total: valor }),
      ...(col.data !== undefined && celulas[col.data] ? { data: celulas[col.data] } : {}),
      ...(col.estado !== undefined && celulas[col.estado] ? { estado: celulas[col.estado] } : {}),
      ...(col.pago !== undefined && celulas[col.pago] ? { pago: celulas[col.pago] } : {}),
    })
  }

  if (!col) {
    throw new WeoError("PARSE", "nao encontrei o cabecalho da tabela de documentos")
  }
  return out
}
