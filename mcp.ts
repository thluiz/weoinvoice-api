/**
 * Camada MCP sobre HTTP, servida pelo proprio servico em POST /mcp.
 *
 * Fina de proposito: nao reimplementa regra nenhuma, so chama as mesmas funcoes
 * que a REST usa. A unica coisa que acrescenta e gerar a idempotencyKey, para
 * que um retry do modelo apos timeout nao emita a fatura duas vezes.
 */

export interface McpHandlers {
  lancarNota(args: any): Promise<unknown>
  catalogo(): Promise<unknown>
  atualizarCatalogo(): Promise<unknown>
  ultimasFaturas(n: number): Promise<unknown>
}

export const TOOLS = [
  {
    name: "weoinvoice_lancar_nota",
    description:
      "Lança uma venda de balcão no weoInvoice e emite o documento fiscal. " +
      "EMITE DOCUMENTO REAL que não pode ser apagado, só estornado por nota de crédito. " +
      "Use dryRun=true para validar sem emitir sempre que houver dúvida sobre artigo, preço ou cliente. " +
      "O artigo pode vir por nome (resolvido no catálogo) ou por artigoId.",
    inputSchema: {
      type: "object",
      properties: {
        itens: {
          type: "array",
          description: "Linhas da venda.",
          items: {
            type: "object",
            properties: {
              artigo: { type: "string", description: "Nome do artigo, ex: CANECA" },
              artigoId: { type: "string", description: "Id do artigo (alternativa ao nome)" },
              precoUnitario: { type: "number", description: "Preço unitário em euros" },
              quantidade: { type: "integer", description: "Padrão 1" },
              descontoPct: { type: "number", description: "Desconto em %, padrão 0" },
            },
            required: ["precoUnitario"],
          },
        },
        clienteId: { type: "string", description: "Padrão: cliente de balcão configurado" },
        tipoDocumento: { type: "string", enum: ["simplificada", "factura"], description: "Padrão simplificada" },
        dryRun: { type: "boolean", description: "true = valida tudo e não emite nada" },
      },
      required: ["itens"],
    },
  },
  {
    name: "weoinvoice_catalogo",
    description:
      "Lista artigos e clientes do weoInvoice a partir do catálogo local. " +
      "Use para descobrir nomes e ids antes de lançar uma nota. Não faz login.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "weoinvoice_atualizar_catalogo",
    description:
      "Vai ao weoInvoice e reescreve o catálogo local. " +
      "Use quando um artigo ou cliente novo foi criado e ainda não aparece.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "weoinvoice_ultimas_faturas",
    description: "Lista os últimos documentos emitidos (número, total, data). Útil para conferir uma emissão.",
    inputSchema: {
      type: "object",
      properties: { ultimas: { type: "integer", description: "Quantas listar, padrão 10" } },
    },
  },
]

export function novaIdempotencyKey() {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Processa uma mensagem JSON-RPC do MCP. Devolve null quando e notificacao. */
export async function tratarMcp(msg: any, h: McpHandlers): Promise<unknown | null> {
  const { id, method, params } = msg ?? {}

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "weoinvoice", version: "0.1.0" },
      },
    }
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } }
  }

  if (method === "tools/call") {
    const nome = params?.name
    const args = params?.arguments ?? {}
    try {
      let saida: unknown
      switch (nome) {
        case "weoinvoice_lancar_nota":
          saida = await h.lancarNota(args)
          break
        case "weoinvoice_catalogo":
          saida = await h.catalogo()
          break
        case "weoinvoice_atualizar_catalogo":
          saida = await h.atualizarCatalogo()
          break
        case "weoinvoice_ultimas_faturas":
          saida = await h.ultimasFaturas(Number(args?.ultimas ?? 10))
          break
        default:
          throw new Error(`tool desconhecida: ${nome}`)
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(saida, null, 2) }] },
      }
    } catch (e: any) {
      // Erro de negocio volta como conteudo com isError, nao como erro de
      // transporte: o modelo precisa de ler a mensagem para decidir o que fazer.
      const corpo = e?.code
        ? { erro: e.code, mensagem: e.message, detalhe: e.extra }
        : { erro: "INTERNO", mensagem: String(e?.message ?? e) }
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(corpo, null, 2) }], isError: true },
      }
    }
  }

  if (id === undefined || id === null) return null // notificacao

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `método não suportado: ${method}` } }
}
