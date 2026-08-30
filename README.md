# weoinvoice-api

HTTP API for posting counter (POS) sales to [weoInvoice](https://www.weoinvoice.com) without
opening a browser.

weoInvoice publishes no API. This service talks to its web interface over plain HTTP —
no Playwright, no Chromium — and exposes a JSON endpoint that issues the document and
returns the invoice number.

> ### ⚠️ This issues real fiscal documents
>
> There is no test environment in weoInvoice, and an issued document **cannot be deleted** —
> it can only be reversed with a credit note. The whole design of this service starts there:
> it would rather refuse a sale than issue a wrong one. Use `dryRun` freely; read
> [Safe by construction](#safe-by-construction) before turning off the guards.

> ### A note on language
>
> The code and this README are in English. The **wire format is in Portuguese** — field
> names (`itens`, `artigoId`, `precoUnitario`), response keys (`sucesso`, `mensagem`) and
> error codes (`CARRINHO_SUJO`, `TOTAL_DIVERGENTE`). So are the assistant skills under
> `clients/`. That is not an oversight: see [Why the wire and the skills are in
> Portuguese](#why-the-wire-and-the-skills-are-in-portuguese).

## How it works

A sale in the weoInvoice POS is a sequence of calls that depend on state held on the
server: the cart lives in the PHP session, not in the request. The service reproduces that
sequence

```
login → empty cart → add article → adjust price → check total → finalize
```

and wraps every step in the protections below.

## Safe by construction

| Risk | What the service does |
|---|---|
| **A retry duplicating an invoice.** If the finalize times out, the invoice may have been created anyway. | `idempotencyKey` is required, backed by an append-only ledger. The key is written as `finalizing` **before** the finalize; if the process dies midway, the key stays locked and the retry is refused instead of issuing again. On a network failure the service looks for the invoice in the listing before reporting an error. |
| **An orphan item.** A sale that failed midway leaves an item in the cart, which would silently join the next invoice. | The cart is read and emptied before every sale, checked item by item once assembled, and torn down by rollback on any error. |
| **A wrong amount on the document.** | The subtotal the site computes is compared against the expected one, line by line and in total. A mismatch aborts before issuing. |
| **Two sales at once** would mix items in the same cart. | Internal queue: one sale at a time, start to finish. |
| **The decimal separator.** | Negotiated at runtime: send one format, check the subtotal that comes back, try the other if it does not match, abort if neither does. This is not paranoia — see the warning below. |
| **The interface changing without notice.** It is an undocumented API. | The parsers fail loudly instead of guessing, and the failure turns into a notification. |

### ⚠️ The decimal separator is not a detail

Sending `price=10.00` makes the site read **1000**: it takes the dot as a thousands
separator. A ten-euro sale would issue a thousand-euro invoice. The correct format is a
comma (`10,00`), but the service does not trust that — it sends, reads the subtotal the
site returns, and only carries on if it matches what was expected. It is the same check
that catches an orphan item and an ignored price, and it is covered by a regression test.

### The `WEO_CART_READ_VERIFIED` guard

Reading the cart is what keeps an orphan item out of the invoice, and the HTML can vary
between accounts. While `WEO_CART_READ_VERIFIED=1` is not in `.env`, `dryRun` works but
real issuing is refused with `HTTP 503`.

Before unlocking it, confirm the parsers against your own account:

```bash
bun run probe.ts --dump   # read-only: adds nothing, issues nothing
```

Check that the articles show up, that the series comes out right, and that the cart is
read with an item in it (add one through the web interface and run it again). Only then
flip the flag.

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/thluiz/weoinvoice-api.git
cd weoinvoice-api
cp .env.example .env && chmod 600 .env   # fill in the credentials
bun run server.ts
```

Find your account's article and client ids in `GET /catalogo` — they are not in the code,
they live in `.env` or in the request.

### As a service

`weoinvoice-api.service` is an example systemd unit. Adjust the paths, and serve it behind
a proxy — the service listens on `127.0.0.1` only. There is an example nginx route in
`weoinvoice.conf`.

## Endpoints

All of them require the `X-Api-Key` header, except `/health`.

### `GET /health`
Service state, whether there is a cached session and whether real issuing is enabled.
Does not log in.

### `GET /catalogo`
The account's POS articles and clients, read from `catalogo.json`. This is what resolves
`"artigo": "NAME"` → id. Does not log in, so it does not drop the browser session.

### `POST /catalogo/refresh`
Goes to weoInvoice, rewrites `catalogo.json` and returns what changed:

```json
{ "sucesso": true, "mudancas": { "artigosNovos": ["..."], "artigosRemovidos": [],
  "clientesNovos": 2, "clientesRemovidos": 0 } }
```

The catalogue lives in a file instead of being fetched on every request because it changes
very rarely and each fetch costs a login. Call this when you create a new article or
client. If weoInvoice returns zero articles, the file is **not** overwritten.

### `GET /faturas?ultimas=N`
The last N documents from the listing, with type, client, amount, date, status and whether
it is paid.

### `GET /faturas/dia?data=YYYY-MM-DD`
Day close: everything issued on that date, with the total and the breakdown by type.
`data` also accepts `hoje` (the default), resolved in the machine's timezone.

```json
{ "sucesso": true, "data": "2026-08-28", "quantidade": 10, "total": 181,
  "porTipo": { "Factura Simplificada": { "quantidade": 10, "total": 181 } },
  "faturas": [ { "numero": "2026/17", "cliente": "...", "total": 30 } ] }
```

The weoInvoice listing does not filter by date (only by client, type and keyword), but it
comes ordered from most recent to oldest. The service walks the pages and stops as soon as
a date earlier than the one wanted shows up, which usually settles it on the first page.
If a page brings no new document, it stops too: the site's paginator is not to be trusted
and a loop here would be silent.

### `POST /pos/sale`

```jsonc
{
  "itens": [
    { "artigoId": "12345", "precoUnitario": 15.00, "quantidade": 1, "descontoPct": 0 }
  ],
  "clienteId": "67890",             // default: WEO_CLIENTE_PADRAO
  "tipoDocumento": "simplificada",  // default; or "factura"
  "serie": "2026",                  // default: read from the POS combobox
  "dryRun": false,
  "idempotencyKey": "uuid-..."      // required when dryRun=false
}
```

Instead of `artigoId` you can send `artigo` with the name. The match is exact and
case-insensitive; an ambiguous name becomes an error listing the candidates, never a
silent pick.

**Success**

```json
{ "sucesso": true, "numero": "2026/12", "idInterno": "...", "total": 15.00, "pdfUrl": "..." }
```

**Dry-run** returns the same shape without `numero`/`idInterno`, plus `formatoDecimal` and
`carrinhoLimpoDepois`. Nothing is issued and the cart is left empty.

**Error**: `{ "sucesso": false, "erro": "<CODE>", "mensagem": "..." }`

| Code | HTTP | Meaning |
|---|---|---|
| `REQUEST` | 400 | invalid payload |
| `NAO_AUTORIZADO` | 401 | `X-Api-Key` missing or wrong |
| `ARTIGO_DESCONHECIDO` | 404 | name not found in the catalogue, or ambiguous |
| `CARRINHO_SUJO` | 409 | there was a leftover item and it could not be removed |
| `TOTAL_DIVERGENTE` | 409 | the site's total does not match the request |
| `FINALIZE_REJEITADO` | 422 | weoInvoice refused — nothing was created |
| `CARRINHO_NAO_VERIFICADO` | 503 | the safety guard is active |
| `SESSAO` / `PARSE` | 502 | authentication failure, or a response in an unexpected format |
| `AMBIGUO_VERIFICAR_LISTAGEM` | 409/502 | **check manually**: a document may have been issued |

`AMBIGUO_VERIFICAR_LISTAGEM` is the only error that demands a human. It means the service
could not determine whether the invoice was created. Check `GET /faturas` before trying
again, and use a fresh `idempotencyKey` if you do re-issue.

## MCP

`POST /mcp` exposes the same operations as MCP tools over HTTP, so an assistant can call
them directly: `weoinvoice_lancar_nota`, `weoinvoice_catalogo`,
`weoinvoice_atualizar_catalogo`, `weoinvoice_ultimas_faturas` and
`weoinvoice_faturas_do_dia`. Each call generates its own `idempotencyKey`, so a retry at
the transport layer does not issue twice.

## Clients

`clients/openclaw/` holds the pieces that let the shop owner post sales from Telegram: two
OpenClaw skills and the script they drive.

| | |
|---|---|
| `SKILL-registrar-venda.md` | Turns a message like *"15 euros de cerâmicas"* into one or more sales. Always preview → confirm → issue. |
| `SKILL-listar-notas-dia.md` | Day close: what was issued on a date, the total and the breakdown by type. Read-only. |
| `pos-venda.py` | `--preview` / `--emitir` with the sales JSON, `--catalogo`, `--dia [date]`. |

They are two separate skills on purpose: querying what has already been issued is a pure
read, issuing a new document is irreversible. Keeping them together forced every query to
carry the whole warning about confirmation and issuing.

The script resolves the date itself (`hoje`, `ontem`, `anteontem`, `DD/MM`, `DD/MM/AAAA`,
`AAAA-MM-DD`, or a number of days back) instead of letting the model convert "yesterday"
into a date it may get wrong. A wrong date in a day close raises no error: it gives a
wrong number that looks right. An impossible date (`31/02`) or ambiguous text
(`"semana passada"`) is refused with a message rather than resolved by approximation.

### Why the wire and the skills are in Portuguese

1. **The operator writes in Portuguese.** The skills are read by a model that has to
   understand messages like *"15, 30 e 50 de canecas"* and answer in the same language,
   on Telegram, mid-sale. Their examples, their disambiguation rules and their refusal
   messages have to be in the language actually being typed. Translating them would mean
   the model matching Portuguese input against English examples.
2. **The catalogue is in Portuguese.** Article and client names come from the weoInvoice
   account as they are (`CERÂMICA`, `CANECA`), and article matching happens by name.
3. **The wire mirrors weoInvoice.** The document types (`Factura`, `Factura
   Simplificada`), the listing header (`Tipo`, `Número`, `Cliente`, `Valor`, `Emissão`,
   `Vencimento`, `Estado`, `Pago`) and the amount format are the site's own. Field names
   and error codes stay in the same language as the thing they describe, so there is no
   mapping layer to get wrong between the parser and the endpoint.

Code, comments, commit history and documentation are in English. Whatever touches
weoInvoice or the person using it stays in Portuguese.

## Development

```bash
bun test          # parsers and money arithmetic, no network and no credentials
```

The HTML parsers sit isolated at the end of `weo.ts` on purpose: they are the fragile part,
the one that breaks if weoInvoice changes its interface, and the one the tests cover best.

## The protocol

Reverse-engineered by inspecting the interface. Every call is a `POST` to `admin.php`,
authenticated by the session cookie, with responses in text separated by `|`, not JSON.

| Action | `func=` | Body | Response |
|---|---|---|---|
| Login | `submitlogin` (`module=user`) | `email`, `password`, `submit` | `302` to the listing |
| Add article | `ajax_addposinvoiceproduct` | `id` | `itemId\|\|name\|\|price\|\|tax` |
| Adjust item | `ajax_updateposinvoiceproduct` | `id`, `quantity`, `price`, `discount` | `qty\|price\|subtotal\|tax\|discount` |
| Remove item | `ajax_removeposinvoiceproduct` | `id` | — |
| Finalize | `ajax_addposinvoice` | `pos_client`, `pos_type_*`, `pos_serie` | `200\|<id>` |

The visible invoice number (`2026/12`) does not come from the finalize — it only shows up
in the listing, where the service reads it after issuing.

Which document types are enabled varies per account: `Factura` and `Factura Simplificada`
(the site's own labels) are the ones this service covers.

Other things you only find out by inspection:

- **The cart belongs to the user, not to the session.** It survives a reload and a new
  login. An item left behind sits there waiting for the next invoice, and the web
  interface does not show it on reload — it rebuilds the cart only from what you click.
  That is why the service reads and empties the cart before every sale.
- **The POS page reflects the server-side cart** in `num_products`, in the `itemNNN` ids
  and in the footer total. That total is computed by the server and is the value that goes
  into the document, which is why it is the one the service checks before finalizing.
- **The series does not come from an endpoint.** The `<select id="pos_serie">` arrives
  empty and `ajax_getseries` is commented out in `pos.js`; the options come from a hidden
  `#pos-serie-standard` block.
- **Mixed encoding.** The HTML pages come in windows-1252 without declaring a charset, the
  AJAX responses in UTF-8. The service decides by content, otherwise accented names arrive
  broken and matching by name fails.

## Disclaimer

Independent project, unaffiliated with weoInvoice. It depends on internal details of their
web interface and may stop working without notice on any update to the site. You are
responsible for the fiscal documents you issue with it.

## License

MIT. See [LICENSE](LICENSE).
