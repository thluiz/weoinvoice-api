/**
 * Testes dos parsers puros — rodam sem credencial e sem rede.
 *   bun test parsers.test.ts
 */

import { expect, test, describe } from "bun:test"
import { parseNum, sameMoney, round2, CENT, parseClientsResponse, parseCartSnapshot, parseSerieHtml, parseInvoiceListHtml } from "./weo"

describe("parseNum", () => {
  test("formato US", () => {
    expect(parseNum("15.50")).toBe(15.5)
    expect(parseNum("1234.56")).toBe(1234.56)
  })
  test("formato PT", () => {
    expect(parseNum("15,50")).toBe(15.5)
    expect(parseNum("1.234,56")).toBe(1234.56)
  })
  test("milhar sem decimal", () => {
    expect(parseNum("1,234")).toBe(1234)
    expect(parseNum("1.234,00")).toBe(1234)
  })
  test("com simbolo de moeda e espaco", () => {
    expect(parseNum("€ 15,50")).toBe(15.5)
    expect(parseNum(" 15.50 EUR")).toBe(15.5)
  })
  test("vazio vira NaN", () => {
    expect(Number.isNaN(parseNum(""))).toBe(true)
    expect(Number.isNaN(parseNum("abc"))).toBe(true)
  })
})

describe("comparacao monetaria", () => {
  test("tolera erro de ponto flutuante", () => {
    expect(sameMoney(0.1 + 0.2, 0.3)).toBe(true)
  })
  test("tolera um cetimo de politica de arredondamento", () => {
    // 15,00 com 3,5% de desconto da 14,475: o site pode arredondar pra cima
    expect(sameMoney(14.475, 14.48)).toBe(true)
  })
  test("pega separador decimal lido errado", () => {
    expect(sameMoney(15.5, 1550)).toBe(false)
    expect(sameMoney(15.5, 15)).toBe(false)
  })
  test("pega item orfao inflando o total", () => {
    expect(sameMoney(15, 30)).toBe(false)
  })
  test("nao tolera divergencia de varios cetimos", () => {
    expect(sameMoney(15.0, 15.05)).toBe(false)
  })
  test("tolerancia do total escala com o numero de linhas", () => {
    expect(sameMoney(100.0, 100.02, CENT * 3)).toBe(true)
    expect(sameMoney(100.0, 100.2, CENT * 3)).toBe(false)
  })
  test("round2 arredonda meio cetimo pra cima apesar do float", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(1.005)).toBe(1.01)
    expect(round2(14.475)).toBe(14.48)
  })
})

describe("parseClientsResponse", () => {
  // formato real: registos separados por "|", campos por "%%", como [id, ?, nome, NIF]
  test("extrai id, nome e NIF", () => {
    const r = parseClientsResponse("1000001%%%%CLIENTE BALCAO%%999999990|1000002%%%%Maria Silva%%123456789")
    expect(r).toHaveLength(2)
    expect(r[0]!.id).toBe("1000001")
    expect(r[0]!.nome).toBe("CLIENTE BALCAO")
    expect(r[1]!.nome).toBe("Maria Silva")
    expect(r[1]!.nif).toBe("123456789")
  })
  test("aceita cliente sem NIF", () => {
    const r = parseClientsResponse("1000003%%%%Cerarte%%")
    expect(r).toHaveLength(1)
    expect(r[0]!.nif).toBeUndefined()
  })
  test("ignora registos vazios", () => {
    expect(parseClientsResponse("||")).toHaveLength(0)
  })
})

describe("parseCartSnapshot", () => {
  const pagina = (num: number, itens: string[], total: string) => `
    <div class="pos-invoice-products-list">
      ${itens.map((i) => `<div class="pos-invoice-products-item" id="item${i}"></div>`).join("")}
    </div>
    <input type="hidden" id="num_products" value="${num}" />
    <div class="pos-invoice-products-total-value"><span>${total}</span></div>`

  test("carrinho vazio", () => {
    const s = parseCartSnapshot(pagina(0, [], "0,00"))
    expect(s.itens).toHaveLength(0)
    expect(s.total).toBe(0)
  })
  test("le itens e o total do servidor em formato PT", () => {
    const s = parseCartSnapshot(pagina(2, ["10992169", "10992170"], "1.234,56"))
    expect(s.itens.map((i) => i.itemId)).toEqual(["10992169", "10992170"])
    expect(s.total).toBe(1234.56)
  })
  test("aborta se a contagem nao bater com os ids (pagina mudou)", () => {
    expect(() => parseCartSnapshot(pagina(3, ["881"], "10,00"))).toThrow(/inconsistente/)
  })
  test("aborta se nao achar o total", () => {
    const html = `<input id="num_products" value="0" />`
    expect(() => parseCartSnapshot(html)).toThrow(/total/)
  })
  test("aborta se nao achar num_products", () => {
    const html = `<div class="pos-invoice-products-total-value"><span>0,00</span></div>`
    expect(() => parseCartSnapshot(html)).toThrow(/num_products/)
  })
  test("nao confunde artigo do catalogo com item do carrinho", () => {
    const html = `<div id="product63855">ARTIGO</div>` + pagina(1, ["881"], "10,00")
    expect(parseCartSnapshot(html).itens.map((i) => i.itemId)).toEqual(["881"])
  })
})

describe("parseSerieHtml", () => {
  // o <select id="pos_serie"> vem VAZIO; a fonte e o bloco #pos-serie-standard
  const bloco = (opts: string) => `<select id="pos_serie"></select>
    <div id="pos-serie-standard">${opts}</div>`

  test("usa a primeira option do bloco escondido", () => {
    const html = bloco(`<option value="2026">2026</option><option value="2025">2025</option>`)
    expect(parseSerieHtml(html)).toBe("2026")
  })
  test("prefere a option marcada como selected", () => {
    const html = bloco(`<option value="2026">2026</option><option value="2025" selected>2025</option>`)
    expect(parseSerieHtml(html)).toBe("2025")
  })
  test("devolve null quando o bloco nao existe (nunca chuta o ano)", () => {
    expect(parseSerieHtml(`<select id="pos_serie"></select>`)).toBeNull()
  })
})

describe("regressao: o bug que emitiria fatura de 1000 euros", () => {
  // Em 2026-08-28 confirmou-se que enviar price=10.00 faz o site ler 1000: ele
  // trata o ponto como separador de milhar. A resposta veio "1,00|1.000,00|1000".
  test("o subtotal devolvido pelo site denuncia o formato errado", () => {
    const subtotalComPonto = parseNum("1000")
    const subtotalComVirgula = parseNum("10")
    expect(sameMoney(subtotalComPonto, 10)).toBe(false) // aborta, como deve
    expect(sameMoney(subtotalComVirgula, 10)).toBe(true) // aceita
  })
  test("o preco devolvido em formato PT le-se correctamente", () => {
    expect(parseNum("1.000,00")).toBe(1000)
    expect(parseNum("10,00")).toBe(10)
  })
})

describe("parseInvoiceListHtml", () => {
  // estrutura real: Tipo | Número | Cliente | Valor | Emissão | Vencimento | Estado | Pago
  const CAB = `<tr><th>Tipo</th><th>Número</th><th>Cliente</th><th>Valor</th>
    <th>Emissão</th><th>Vencimento</th><th>Estado</th><th>Pago</th></tr>`
  const linha = (n: string, cli: string, val: string, dt: string) =>
    `<tr><td>Factura Simplificada</td><td>${n}</td><td>${cli}</td><td>${val}</td>
     <td>${dt}</td><td>${dt}</td><td>Fechado</td><td>Pago</td></tr>`

  test("lê as colunas pela posição do cabeçalho", () => {
    const html = `<table>${CAB}${linha("2026/17", "INDIFERENCIADO", "30,00 €", "2026-08-28")}</table>`
    const r = parseInvoiceListHtml(html)
    expect(r).toHaveLength(1)
    expect(r[0]!.numero).toBe("2026/17")
    expect(r[0]!.total).toBe(30)
    expect(r[0]!.data).toBe("2026-08-28")
    expect(r[0]!.estado).toBe("Fechado")
  })

  test("o cliente é o cliente, não o tipo de documento", () => {
    // regressão: a heurística antiga apanhava "Factura Simplificada" como cliente
    const html = `<table>${CAB}${linha("2026/17", "INDIFERENCIADO", "30,00 €", "2026-08-28")}</table>`
    const f = parseInvoiceListHtml(html)[0]!
    expect(f.cliente).toBe("INDIFERENCIADO")
    expect(f.tipo).toBe("Factura Simplificada")
  })

  test("ignora a linha de cabeçalho e a barra de filtros", () => {
    const filtros = `<tr><td>Adicionar</td><td>- Filtrar por Cliente - INDIFERENCIADO</td></tr>`
    const html = `<table>${filtros}${CAB}${linha("2026/17", "INDIFERENCIADO", "30,00 €", "2026-08-28")}</table>`
    expect(parseInvoiceListHtml(html)).toHaveLength(1)
  })

  test("aborta se o cabeçalho não existir (página mudou)", () => {
    const html = `<table><tr><td>2026/11</td><td>1,00</td></tr></table>`
    expect(() => parseInvoiceListHtml(html)).toThrow(/cabecalho/)
  })

  test("preserva a ordem para o corte por data", () => {
    const html = `<table>${CAB}
      ${linha("2026/17", "A", "30,00 €", "2026-08-28")}
      ${linha("2026/16", "B", "25,00 €", "2026-08-28")}
      ${linha("2026/9", "C", "10,00 €", "2026-08-27")}</table>`
    const r = parseInvoiceListHtml(html)
    expect(r.map((f) => f.numero)).toEqual(["2026/17", "2026/16", "2026/9"])
    expect(r.filter((f) => f.data === "2026-08-28")).toHaveLength(2)
  })
})
