/**
 * probe.ts — investigacao READ-ONLY das questoes em aberto do plano.
 *
 * NAO emite documento, NAO adiciona item ao carrinho. Apenas faz login e
 * despeja o HTML das paginas relevantes para confirmar os parsers de weo.ts:
 *
 *   1. como o carrinho POS aparece no DOM (pre-requisito do R2 / fail-closed)
 *   2. como os artigos POS aparecem (catalogo dinamico)
 *   3. qual e o combobox de serie
 *   4. como a listagem de documentos se estrutura (reconciliacao do R1)
 *
 * Uso:  bun run probe.ts            (usa o .env carregado pelo systemd/dotenv)
 *       bun run probe.ts --dump     (grava o HTML cru em /tmp/weoinvoice-probe/)
 */

import { mkdir, writeFile } from "node:fs/promises"
import {
  WeoClient, BASE,
  parseCartHtml, parsePosProductsHtml, parseSerieHtml, parseInvoiceListHtml,
} from "./weo"

const DUMP = process.argv.includes("--dump")
const DUMP_DIR = "/tmp/weoinvoice-probe"

const EMAIL = process.env.WEOINVOICE_EMAIL ?? ""
const PASSWORD = process.env.WEOINVOICE_PASSWORD ?? ""
if (!EMAIL || !PASSWORD) {
  console.error("faltam WEOINVOICE_EMAIL / WEOINVOICE_PASSWORD no ambiente")
  process.exit(1)
}

const client = new WeoClient({
  email: EMAIL,
  password: PASSWORD,
  sessionPath: `${import.meta.dir}/session.json`,
  log: (m, x) => console.log("  [client]", m, x ? JSON.stringify(x) : ""),
})

function titulo(t: string) {
  console.log("\n" + "=".repeat(70) + "\n" + t + "\n" + "=".repeat(70))
}

async function baixar(qs: string, nome: string): Promise<string> {
  const html = await client.get(qs)
  console.log(`GET ${qs} -> ${html.length} bytes`)
  if (DUMP) {
    await mkdir(DUMP_DIR, { recursive: true })
    await writeFile(`${DUMP_DIR}/${nome}.html`, html, "utf8")
    console.log(`  (gravado em ${DUMP_DIR}/${nome}.html)`)
  }
  return html
}

/** Mostra os trechos do HTML em volta de um termo, pra inspecionar estrutura. */
function contexto(html: string, termo: RegExp, janela = 300, max = 3) {
  let n = 0
  for (const m of html.matchAll(termo)) {
    if (n++ >= max) break
    const i = m.index ?? 0
    const trecho = html.slice(Math.max(0, i - janela / 2), i + janela).replace(/\s+/g, " ")
    console.log(`  ...${trecho}...`)
  }
  if (n === 0) console.log("  (nenhuma ocorrencia)")
}

async function main() {
  titulo("1. LOGIN")
  await client.login()
  console.log("login ok")

  titulo("2. PAGINA POS — carrinho, artigos e serie")
  const pos = await baixar("module=invoice&func=pos", "pos")

  console.log("\n-- artigos detectados pelo parser --")
  const artigos = parsePosProductsHtml(pos)
  console.log(`total: ${artigos.length}`)
  for (const a of artigos.slice(0, 12)) console.log(`  ${a.id}  ${a.nome.slice(0, 60)}`)

  console.log("\n-- serie detectada pelo parser --")
  console.log(`  ${parseSerieHtml(pos) ?? "(nao encontrada)"}`)
  console.log("-- contexto de pos_serie no HTML --")
  contexto(pos, /pos_serie/gi, 400, 2)

  console.log("\n-- carrinho detectado pelo parser (deve estar VAZIO agora) --")
  const carrinho = parseCartHtml(pos)
  console.log(`  itens: ${carrinho.length}`, carrinho.map((c) => c.itemId))

  console.log("\n-- candidatos a container do carrinho no HTML --")
  contexto(pos, /removePosInvoiceProduct|posinvoiceproduct|pos_items|posinvoicetable/gi, 400, 5)

  console.log("\n-- ids de tabela/div na pagina (pra achar o container certo) --")
  const ids = [...pos.matchAll(/id=["']([a-z0-9_-]{3,40})["']/gi)]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i && !/^product\d+$/.test(v))
  console.log("  " + ids.slice(0, 60).join(", "))

  titulo("3. LISTAGEM DE DOCUMENTOS — reconciliacao do R1")
  const lista = await baixar("module=invoice&func=list", "list")
  const faturas = parseInvoiceListHtml(lista)
  console.log(`faturas detectadas pelo parser: ${faturas.length}`)
  for (const f of faturas.slice(0, 8)) console.log(`  ${JSON.stringify(f)}`)
  if (!faturas.length) {
    console.log("-- contexto de numeros tipo 2026/N no HTML --")
    contexto(lista, /\d{4}\/\d+/g, 400, 4)
  }

  titulo("4. CLIENTES (ajax_getclients)")
  try {
    const clientes = await client.getClients()
    console.log(`clientes detectados: ${clientes.length}`)
    for (const c of clientes.slice(0, 10)) console.log(`  ${JSON.stringify(c)}`)
    const indif = clientes.find((c) => /INDIFERENCIADO/i.test(c.nome))
    console.log(`INDIFERENCIADO: ${indif ? indif.id : "(nao achado)"}`)
  } catch (e) {
    console.log("falhou:", String(e))
  }

  titulo("5. ENDPOINTS AJAX CANDIDATOS PARA LER O CARRINHO")
  // Se algum destes existir, ler o carrinho fica muito mais solido que parsear HTML.
  const candidatos = [
    "ajax_getposinvoiceproducts",
    "ajax_getposinvoiceproduct",
    "ajax_listposinvoiceproducts",
    "ajax_getposproducts",
    "ajax_getposinvoice",
    "ajax_getposconfiguration",
  ]
  for (const func of candidatos) {
    try {
      const t = (await client.post(func, "")).replace(/\s+/g, " ").trim()
      console.log(`  ${func} -> ${t.length} bytes: ${t.slice(0, 160)}`)
    } catch (e) {
      console.log(`  ${func} -> ${String(e)}`)
    }
  }

  titulo("RESUMO")
  console.log(`artigos parseados ......... ${artigos.length}`)
  console.log(`serie parseada ............ ${parseSerieHtml(pos) ?? "FALHOU"}`)
  console.log(`faturas parseadas ......... ${faturas.length}`)
  console.log(`carrinho (vazio esperado) . ${carrinho.length} itens`)
  console.log("\nSe artigos/serie/faturas vieram plausiveis e o carrinho vazio,")
  console.log("falta so confirmar o carrinho COM item — isso exige um add, que e reversivel.")
}

main().catch((e) => {
  console.error("ERRO:", e)
  process.exit(1)
})
