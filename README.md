# weoinvoice-api

API HTTP para lançar vendas de balcão (POS) no [weoInvoice](https://www.weoinvoice.com) sem abrir o browser.

O weoInvoice não publica uma API. Este serviço fala com a interface web dela por HTTP puro
— sem Playwright, sem Chromium — e expõe um endpoint JSON que emite o documento e devolve
o número da fatura.

> ### ⚠️ Isto emite documento fiscal real
>
> Não existe ambiente de testes no weoInvoice, e documento emitido **não se apaga** —
> só se estorna com nota de crédito. Todo o desenho deste serviço parte daí: ele prefere
> recusar uma venda a emitir uma errada. Use `dryRun` à vontade; leia a seção
> [Segurança por construção](#segurança-por-construção) antes de desligar as travas.

## Como funciona

Uma venda no POS do weoInvoice é uma sequência de chamadas que dependem de estado no
servidor: o carrinho vive na sessão PHP, não no pedido. O serviço reproduz essa sequência

```
login → limpa carrinho → adiciona artigo → ajusta preço → confere total → finaliza
```

e envolve cada passo nas proteções abaixo.

## Segurança por construção

| Risco | Resposta do serviço |
|---|---|
| **Retry duplicando fatura.** Se o finalize der timeout, a fatura pode ter sido criada mesmo assim. | `idempotencyKey` obrigatória e um ledger append-only. A chave é gravada como `finalizing` **antes** do finalize; se o processo morrer no meio, ela trava e o retry é recusado em vez de emitir de novo. Em falha de rede, o serviço procura a fatura na listagem antes de reportar erro. |
| **Item órfão.** Uma venda que falhou no meio deixa item no carrinho, que entraria silenciosamente na fatura seguinte. | O carrinho é lido e esvaziado antes de cada venda, conferido item a item depois de montado, e desmontado por rollback em qualquer erro. |
| **Valor errado no documento.** | O subtotal que o site calcula é comparado com o esperado, linha a linha e no total. Divergência aborta antes de emitir. |
| **Duas vendas ao mesmo tempo** misturariam itens no mesmo carrinho. | Fila interna: uma venda por vez, do início ao fim. |
| **Separador decimal.** Não está documentado se o site quer `15.50` ou `15,50`. | Descoberto em runtime: manda com ponto, confere o subtotal devolvido; se não bater, tenta vírgula; se ainda não bater, aborta. O formato que funcionou fica memorizado. |
| **A interface mudar sem aviso.** É uma API não documentada. | Os parsers falham alto em vez de chutar, e a falha vira notificação. |

### A trava `WEO_CART_READ_VERIFIED`

Ler o carrinho é o que impede um item órfão de entrar na fatura, e o parser que faz isso
depende de HTML que varia entre contas. Enquanto `WEO_CART_READ_VERIFIED=1` não estiver
no `.env`:

- `dryRun: true` funciona normalmente;
- emissão real é recusada com `HTTP 503 CARRINHO_NAO_VERIFICADO`.

Para destravar, rode o probe, confira a estrutura do carrinho no HTML despejado, ajuste
`parseCartHtml` em `weo.ts` se necessário, e só então mude a flag:

```bash
bun run probe.ts --dump   # read-only: não adiciona nem emite nada
```

## Instalação

Requer [Bun](https://bun.sh).

```bash
git clone https://github.com/thluiz/weoinvoice-api.git
cd weoinvoice-api
cp .env.example .env && chmod 600 .env   # preencher credenciais
bun run server.ts
```

Descubra os ids de artigo e cliente da sua conta em `GET /catalogo` — eles não estão no
código, ficam todos no `.env` ou no pedido.

### Como serviço

`weoinvoice-api.service` é um unit systemd de exemplo. Ajuste os caminhos, e sirva atrás
de um proxy — o serviço escuta apenas em `127.0.0.1`. Exemplo de rota nginx em
`weoinvoice.conf`.

## Endpoints

Todos exigem o header `X-Api-Key`, exceto `/health`.

### `GET /health`
Estado do serviço, se há sessão em cache e se a emissão real está habilitada. Não faz login.

### `GET /catalogo[?refresh=1]`
Artigos POS e clientes da conta, com cache de 1h. É o que resolve `"artigo": "NOME"` → id.

### `GET /faturas?ultimas=N`
Últimos N documentos da listagem.

### `POST /pos/sale`

```jsonc
{
  "itens": [
    { "artigoId": "12345", "precoUnitario": 15.00, "quantidade": 1, "descontoPct": 0 }
  ],
  "clienteId": "67890",             // default: WEO_CLIENTE_PADRAO
  "tipoDocumento": "simplificada",  // default; ou "factura"
  "serie": "2026",                  // default: lida do combobox do POS
  "dryRun": false,
  "idempotencyKey": "uuid-..."      // obrigatória quando dryRun=false
}
```

Em vez de `artigoId` dá para mandar `artigo` com o nome. O match é exato e
case-insensitive; nome ambíguo vira erro listando os candidatos, nunca uma escolha
silenciosa.

**Sucesso**

```json
{ "sucesso": true, "numero": "2026/12", "idInterno": "...", "total": 15.00, "pdfUrl": "..." }
```

**Dry-run** devolve a mesma forma sem `numero`/`idInterno`, mais `formatoDecimal` e
`carrinhoLimpoDepois`. Nada é emitido e o carrinho fica vazio.

**Erro**: `{ "sucesso": false, "erro": "<CODIGO>", "mensagem": "..." }`

| Código | HTTP | Significado |
|---|---|---|
| `REQUEST` | 400 | payload inválido |
| `NAO_AUTORIZADO` | 401 | `X-Api-Key` ausente ou errada |
| `ARTIGO_DESCONHECIDO` | 404 | nome não encontrado ou ambíguo no catálogo |
| `CARRINHO_SUJO` | 409 | havia item anterior e não foi possível removê-lo |
| `TOTAL_DIVERGENTE` | 409 | o total do site não bate com o pedido |
| `FINALIZE_REJEITADO` | 422 | o weoInvoice recusou — nada foi criado |
| `CARRINHO_NAO_VERIFICADO` | 503 | trava de segurança ativa |
| `SESSAO` / `PARSE` | 502 | falha de autenticação ou resposta em formato inesperado |
| `AMBIGUO_VERIFICAR_LISTAGEM` | 409/502 | **conferir manualmente**: pode haver documento emitido |

`AMBIGUO_VERIFICAR_LISTAGEM` é o único erro que exige ação humana. Significa que o
serviço não conseguiu determinar se a fatura foi criada. Confira `GET /faturas` antes de
tentar de novo, e use uma `idempotencyKey` nova se for reemitir.

## Desenvolvimento

```bash
bun test          # parsers e aritmética monetária, sem rede nem credencial
```

Os parsers de HTML ficam isolados no fim de `weo.ts` de propósito: são a parte frágil,
a que quebra se o weoInvoice mudar a interface, e a que os testes cobrem melhor.

## O protocolo

Levantado por inspeção da interface. A sessão é mantida por cookie, e as chamadas levam um
`js_enabled=1`. Todas as chamadas são `POST` em `admin.php` com respostas de texto
separado por `|`, não JSON.

| Ação | `func=` | Corpo | Resposta |
|---|---|---|---|
| Login | `submitlogin` (`module=user`) | `email`, `password`, `submit` | `302` para a listagem |
| Adicionar artigo | `ajax_addposinvoiceproduct` | `id` | `itemId\|\|nome\|\|preço\|\|taxa` |
| Ajustar item | `ajax_updateposinvoiceproduct` | `id`, `quantity`, `price`, `discount` | `qtd\|preço\|subtotal\|taxa\|desconto` |
| Remover item | `ajax_removeposinvoiceproduct` | `id` | — |
| Finalizar | `ajax_addposinvoice` | `pos_client`, `pos_type_*`, `pos_serie` | `200\|<id>` |

O número visível da fatura (`2026/12`) não vem do finalize — só aparece na listagem, de
onde o serviço o lê depois de emitir.

Os tipos de documento habilitados variam por conta: `Factura` e `Factura Simplificada`
são os que este serviço cobre.

## Aviso

Projeto independente, sem relação com a weoInvoice. Depende de detalhes internos da
interface web dela e pode parar de funcionar sem aviso a qualquer atualização do site.
Você é responsável pelos documentos fiscais que emitir com isto.
