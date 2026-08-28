/**
 * Catalogo de artigos e clientes em ficheiro.
 *
 * Estas listas quase nunca mudam (6 artigos, ~30 clientes), e busca-las ao vivo
 * obrigava a fazer login so para responder uma consulta — o que derruba a sessao
 * do browser do utilizador. Por isso ficam em disco e so se actualizam quando
 * alguem pede: `POST /catalogo/refresh`.
 */

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import type { WeoClient } from "./weo"

export interface Artigo {
  id: string
  nome: string
}

export interface Cliente {
  id: string
  nome: string
  nif?: string
}

export interface Catalogo {
  atualizadoEm: string
  artigos: Artigo[]
  clientes: Cliente[]
}

export interface Mudancas {
  artigosNovos: string[]
  artigosRemovidos: string[]
  clientesNovos: number
  clientesRemovidos: number
}

export class CatalogoStore {
  private cache: Catalogo | null = null

  constructor(private path: string) {}

  /** Le do disco. Devolve null se ainda nao houver ficheiro. */
  async carregar(): Promise<Catalogo | null> {
    if (this.cache) return this.cache
    if (!existsSync(this.path)) return null
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Catalogo
      return this.cache
    } catch (e) {
      throw new Error(`catalogo.json ilegivel: ${String(e)}`)
    }
  }

  private async gravar(c: Catalogo) {
    await writeFile(this.path, JSON.stringify(c, null, 2) + "\n", "utf8")
    this.cache = c
  }

  /**
   * Vai ao weoInvoice, reescreve o ficheiro e diz o que mudou.
   * Artigo que desaparece do catalogo e sinal de atencao: pode haver pedido
   * gravado algures a referencia-lo pelo nome.
   */
  async atualizar(client: WeoClient): Promise<{ catalogo: Catalogo; mudancas: Mudancas }> {
    const anterior = await this.carregar()

    await client.ensureSession()
    const [artigos, clientes] = await Promise.all([client.getPosProducts(), client.getClients()])

    if (!artigos.length) {
      throw new Error("o weoInvoice devolveu zero artigos — a recusar sobrescrever o catalogo")
    }

    const novo: Catalogo = {
      atualizadoEm: new Date().toISOString(),
      artigos: artigos.map((a) => ({ id: a.id, nome: a.nome })).sort((x, y) => x.nome.localeCompare(y.nome)),
      clientes: clientes.sort((x, y) => x.nome.localeCompare(y.nome)),
    }

    const antesIds = new Set((anterior?.artigos ?? []).map((a) => a.id))
    const depoisIds = new Set(novo.artigos.map((a) => a.id))
    const nomePorId = new Map([...(anterior?.artigos ?? []), ...novo.artigos].map((a) => [a.id, a.nome]))

    const mudancas: Mudancas = {
      artigosNovos: [...depoisIds].filter((i) => !antesIds.has(i)).map((i) => nomePorId.get(i) ?? i),
      artigosRemovidos: [...antesIds].filter((i) => !depoisIds.has(i)).map((i) => nomePorId.get(i) ?? i),
      clientesNovos: Math.max(0, novo.clientes.length - (anterior?.clientes.length ?? 0)),
      clientesRemovidos: Math.max(0, (anterior?.clientes.length ?? 0) - novo.clientes.length),
    }

    await this.gravar(novo)
    return { catalogo: novo, mudancas }
  }

  /** Le do disco; se nao houver ficheiro ainda, busca e grava. */
  async obter(client: WeoClient): Promise<Catalogo> {
    const c = await this.carregar()
    if (c) return c
    return (await this.atualizar(client)).catalogo
  }
}

/**
 * Resolve um nome de artigo para id. Match exacto primeiro, depois prefixo.
 * Ambiguidade e erro com a lista de candidatos — nunca escolha silenciosa.
 */
export function resolverPorNome(artigos: Artigo[], nome: string): { id?: string; candidatos?: string[] } {
  const alvo = nome.trim().toLowerCase()
  const exatos = artigos.filter((a) => a.nome.toLowerCase() === alvo)
  if (exatos.length === 1) return { id: exatos[0]!.id }
  if (exatos.length > 1) return { candidatos: exatos.map((a) => a.nome) }

  const parciais = artigos.filter((a) => a.nome.toLowerCase().startsWith(alvo))
  if (parciais.length === 1) return { id: parciais[0]!.id }
  return { candidatos: parciais.map((a) => a.nome) }
}
