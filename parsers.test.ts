/**
 * Testes dos parsers puros — rodam sem credencial e sem rede.
 *   bun test parsers.test.ts
 */

import { expect, test, describe } from "bun:test"
import { parseNum, sameMoney, round2, CENT, parseClientsResponse, parseCartHtml, parseSerieHtml, parseInvoiceListHtml } from "./weo"

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
  test("extrai id, nome e NIF", () => {
    const r = parseClientsResponse("1000001|CLIENTE BALCAO|999999990%%1000002|Maria Silva|123456789")
    expect(r).toHaveLength(2)
    expect(r[0]!.id).toBe("1000001")
    expect(r[0]!.nome).toBe("CLIENTE BALCAO")
    expect(r[1]!.nome).toBe("Maria Silva")
    expect(r[1]!.nif).toBe("123456789")
  })
  test("ignora registros vazios", () => {
    expect(parseClientsResponse("%%%%")).toHaveLength(0)
  })
})

describe("parseCartHtml", () => {
  test("carrinho vazio nao inventa item", () => {
    expect(parseCartHtml("<html><body><p>sem nada</p></body></html>")).toHaveLength(0)
  })
  test("acha itens pelo handler de remocao", () => {
    const html = `<table id="posinvoicetable">
      <tr><td>ARTIGO A</td><td><a onclick="removePosInvoiceProduct(881)">x</a></td></tr>
      <tr><td>ARTIGO B</td><td><a onclick="removePosInvoiceProduct(882)">x</a></td></tr>
    </table>`
    expect(parseCartHtml(html).map((c) => c.itemId)).toEqual(["881", "882"])
  })
  test("nao confunde artigo do catalogo com item do carrinho", () => {
    // os artigos ficam FORA da regiao do carrinho e nao podem ser contados
    const html = `<div id="product12345">ARTIGO NO CATALOGO</div>
      <table id="posinvoicetable"><tr><td><a onclick="removePosInvoiceProduct(881)">x</a></td></tr></table>`
    expect(parseCartHtml(html).map((c) => c.itemId)).toEqual(["881"])
  })
  test("nao duplica item citado duas vezes", () => {
    const html = `<table id="posinvoicetable">
      <tr id="posinvoiceproduct881"><td><a onclick="removePosInvoiceProduct(881)">x</a></td></tr>
    </table>`
    expect(parseCartHtml(html)).toHaveLength(1)
  })
})

describe("parseSerieHtml", () => {
  test("prefere a option marcada como selected", () => {
    const html = `<select name="pos_serie">
      <option value="2025">2025</option>
      <option value="2026" selected>2026</option>
    </select>`
    expect(parseSerieHtml(html)).toBe("2026")
  })
  test("cai para a primeira option quando nada esta selected", () => {
    const html = `<select name="pos_serie"><option value="2026">2026</option></select>`
    expect(parseSerieHtml(html)).toBe("2026")
  })
  test("devolve null quando o combobox nao existe (nunca chuta o ano)", () => {
    expect(parseSerieHtml("<html></html>")).toBeNull()
  })
})

describe("parseInvoiceListHtml", () => {
  test("extrai numero e total das linhas", () => {
    const html = `<table>
      <tr><td>2026/11</td><td>28-08-2026</td><td>CLIENTE BALCAO</td><td>1,00</td></tr>
      <tr><td>2026/10</td><td>28-08-2026</td><td>CLIENTE BALCAO</td><td>10,00</td></tr>
    </table>`
    const r = parseInvoiceListHtml(html)
    expect(r).toHaveLength(2)
    expect(r[0]!.numero).toBe("2026/11")
    expect(r[0]!.total).toBe(1)
    expect(r[1]!.total).toBe(10)
  })
  test("ignora linhas de cabecalho", () => {
    const html = `<table><tr><th>Numero</th><th>Total</th></tr>
      <tr><td>2026/11</td><td>1,00</td></tr></table>`
    expect(parseInvoiceListHtml(html)).toHaveLength(1)
  })
})
