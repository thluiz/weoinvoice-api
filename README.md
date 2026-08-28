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
| **Separador decimal.** | Negociado em runtime: manda um formato, confere o subtotal devolvido, tenta o outro se não bater, aborta se nenhum bater. Não é paranoia — ver o aviso abaixo. |
| **A interface mudar sem aviso.** É uma API não documentada. | Os parsers falham alto em vez de chutar, e a falha vira notificação. |

### ⚠️ O separador decimal não é detalhe

Enviar `price=10.00` faz o site interpretar **1000**: ele lê o ponto como separador de
milhar. Uma venda de dez euros emitiria uma fatura de mil. O formato correto é vírgula
(`10,00`), mas o serviço não confia nisso — ele envia, lê o subtotal que o site devolve, e
só prossegue se bater com o esperado. É a mesma verificação que apanha item órfão e preço
ignorado, e está coberta por teste de regressão.

### A trava `WEO_CART_READ_VERIFIED`

Ler o carrinho é o que impede um item órfão de entrar na fatura, e o HTML pode variar
entre contas. Enquanto `WEO_CART_READ_VERIFIED=1` não estiver no `.env`, `dryRun` funciona
mas a emissão real é recusada com `HTTP 503`.

Antes de destravar, confirme os parsers contra a sua conta:

```bash
bun run probe.ts --dump   # read-only: não adiciona nem emite nada
```

Confira que os artigos aparecem, que a série sai correta, e que o carrinho é lido com um
item presente (adicione um pela interface web e volte a correr). Só então mude a flag.

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

### `GET /catalogo`
Artigos POS e clientes da conta, lidos de `catalogo.json`. É o que resolve
`"artigo": "NOME"` → id. Não faz login, portanto não derruba a sessão do browser.

### `POST /catalogo/refresh`
Vai ao weoInvoice, reescreve `catalogo.json` e devolve o que mudou:

```json
{ "sucesso": true, "mudancas": { "artigosNovos": ["..."], "artigosRemovidos": [],
  "clientesNovos": 2, "clientesRemovidos": 0 } }
```

O catálogo fica em ficheiro em vez de ser buscado a cada pedido porque muda muito
raramente e cada busca custa um login. Chame isto quando criar artigo ou cliente novo.
Se o weoInvoice devolver zero artigos, o ficheiro **não** é sobrescrito.

### `GET /faturas?ultimas=N`
Últimos N documentos da listagem, com tipo, cliente, valor, data, estado e se está pago.

### `GET /faturas/dia?data=YYYY-MM-DD`
Fecho do dia: tudo o que foi emitido nessa data, com o total e a divisão por tipo.
`data` aceita `hoje` (padrão), resolvido no fuso da máquina.

```json
{ "sucesso": true, "data": "2026-08-28", "quantidade": 10, "total": 181,
  "porTipo": { "Factura Simplificada": { "quantidade": 10, "total": 181 } },
  "faturas": [ { "numero": "2026/17", "cliente": "...", "total": 30 } ] }
```

A listagem do weoInvoice não filtra por data (só por cliente, tipo e palavra-chave), mas
vem ordenada da mais recente para a mais antiga. O serviço percorre as páginas e para
assim que aparece uma data anterior à procurada, o que normalmente resolve na primeira.
Se uma página não trouxer documento novo, para também: o paginador do site não é de
confiar e um ciclo aqui seria silencioso.

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

Outras coisas que só se descobrem por inspeção:

- **O carrinho pertence ao utilizador, não à sessão.** Sobrevive a reload e a novo login.
  Um item deixado para trás fica lá à espera da próxima fatura, e a interface web não o
  mostra ao recarregar — ela reconstrói o carrinho só a partir do que você clica.
  Por isso o serviço lê e esvazia o carrinho antes de cada venda.
- **A página POS reflete o carrinho do servidor** em `num_products`, nos ids `itemNNN` e
  no rodapé de total. Esse total é calculado pelo servidor e é o valor que vai para o
  documento, por isso é ele que o serviço confere antes de finalizar.
- **A série não vem de um endpoint.** O `<select id="pos_serie">` chega vazio e o
  `ajax_getseries` está comentado no `pos.js`; as opções vêm de um bloco escondido
  `#pos-serie-standard`.
- **Encoding misto.** As páginas HTML vêm em windows-1252 sem declarar charset, as
  respostas AJAX em UTF-8. O serviço decide pelo conteúdo, senão nomes acentuados chegam
  partidos e o match por nome falha.

## Aviso

Projeto independente, sem relação com a weoInvoice. Depende de detalhes internos da
interface web dela e pode parar de funcionar sem aviso a qualquer atualização do site.
Você é responsável pelos documentos fiscais que emitir com isto.
