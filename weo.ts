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
    const text = await res.text()
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
    const text = await res.text()
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
   * Le os itens atualmente no carrinho POS.
   *
   * O carrinho vive na sessao PHP do servidor, entao item orfao de uma venda que
   * falhou entraria silenciosamente na proxima fatura. Ver R2 no plano.
   *
   * PROBE: os seletores abaixo foram deduzidos, nao confirmados contra o DOM real.
   * `probe.mjs` despeja o HTML pra fechar essa questao. Enquanto
   * WEO_CART_READ_VERIFIED nao estiver setado, o servidor recusa finalizar.
   */
  async readCart(): Promise<CartItem[]> {
    const html = await this.get("module=invoice&func=pos")
    return parseCartHtml(html)
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
    const ordem: Array<"dot" | "comma"> = this.priceStyle ? [this.priceStyle] : ["dot", "comma"]
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

  async listInvoices(limite = 10): Promise<Array<{ numero: string; total?: number; cliente?: string; data?: string }>> {
    const html = await this.get("module=invoice&func=list")
    return parseInvoiceListHtml(html).slice(0, limite)
  }

  invoicePdfUrl(idInterno: string) {
    return `${BASE}/admin.php?module=invoice&func=print&id=${encodeURIComponent(idInterno)}&original=true`
  }
}

// ---------------------------------------------------------------- parsers
// Isolados aqui de proposito: sao a parte fragil (R5). Todos falham alto em vez
// de chutar, e sao os alvos do probe.mjs.

/** PROBE: confirmar contra o DOM real antes de habilitar WEO_CART_READ_VERIFIED. */
export function parseCartHtml(html: string): CartItem[] {
  const encontrados = new Map<string, CartItem>()

  // A tabela do carrinho fica entre o marcador de itens e o rodape de totais.
  const regiao = sliceCartRegion(html)
  const alvo = regiao ?? ""

  const padroes = [
    /removePosInvoiceProduct\((?:'|")?(\d+)(?:'|")?\)/gi,
    /id=["']posinvoiceproduct(\d+)["']/gi,
    /id=["']posproduct(\d+)["']/gi,
    /data-posinvoiceproduct=["'](\d+)["']/gi,
  ]
  for (const re of padroes) {
    for (const m of alvo.matchAll(re)) {
      const id = m[1]!
      if (!encontrados.has(id)) encontrados.set(id, { itemId: id })
    }
  }
  return [...encontrados.values()]
}

function sliceCartRegion(html: string): string | null {
  const inicio = html.search(/id=["'](?:pos_?invoice_?products|posinvoicetable|pos_items)["']/i)
  if (inicio === -1) return null
  const resto = html.slice(inicio)
  const fim = resto.search(/<\/table>/i)
  return fim === -1 ? resto : resto.slice(0, fim)
}

/** Resposta de ajax_getclients: registros separados por %% e campos por |. */
export function parseClientsResponse(text: string): Array<{ id: string; nome: string; nif?: string }> {
  const out: Array<{ id: string; nome: string; nif?: string }> = []
  for (const bruto of text.split("%%")) {
    const reg = bruto.trim()
    if (!reg) continue
    const campos = reg.split("|").map((c) => c.trim())
    const id = campos.find((c) => /^\d{4,}$/.test(c))
    const nome = campos.find((c) => c && !/^\d+$/.test(c))
    if (!id || !nome) continue
    const nif = campos.find((c) => /^\d{9}$/.test(c) && c !== id)
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

/** PROBE: a serie corrente e a option selecionada no combobox pos_serie. */
export function parseSerieHtml(html: string): string | null {
  const sel = html.match(/<select[^>]*name=["']pos_serie["'][\s\S]*?<\/select>/i)?.[0]
  if (!sel) return null
  const selecionada = sel.match(/<option[^>]*selected[^>]*value=["']([^"']+)["']/i)?.[1]
    ?? sel.match(/<option[^>]*value=["']([^"']+)["'][^>]*selected/i)?.[1]
  if (selecionada) return selecionada.trim()
  const primeira = sel.match(/<option[^>]*value=["']([^"']+)["']/i)?.[1]
  return primeira ? primeira.trim() : null
}

/** PROBE: linhas da listagem de documentos. Usado pela reconciliacao (R1). */
export function parseInvoiceListHtml(html: string): Array<{ numero: string; total?: number; cliente?: string; data?: string }> {
  const out: Array<{ numero: string; total?: number; cliente?: string; data?: string }> = []
  const linhas = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  for (const tr of linhas) {
    const celulas = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      (m[1] ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(),
    )
    if (!celulas.length) continue
    const numero = celulas.find((c) => /^\d{4}\/\d+$/.test(c))
    if (!numero) continue
    const data = celulas.find((c) => /^\d{2,4}[-/]\d{2}[-/]\d{2,4}$/.test(c))
    const valores = celulas.filter((c) => /\d/.test(c) && /[.,]\d{2}\b/.test(c)).map(parseNum).filter((n) => !isNaN(n))
    const cliente = celulas.find((c) => c.length > 3 && !/\d{2}[-/:]/.test(c) && !/^\d/.test(c))
    out.push({
      numero,
      ...(valores.length ? { total: Math.max(...valores) } : {}),
      ...(cliente ? { cliente } : {}),
      ...(data ? { data } : {}),
    })
  }
  return out
}
