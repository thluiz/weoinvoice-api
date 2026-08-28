---
name: pos-registrar-venda
description: Regista vendas de balcão no weoInvoice e emite o documento fiscal. Use quando o usuário mandar valores de venda como "15 euros de cerâmicas" ou "15, 30 e 50 de canecas", ou chamar /pos-registrar-venda.
metadata: { "openclaw": { "emoji": "🧾" } }
---

# Registar venda — weoInvoice

Emite **documento fiscal real**. Não existe apagar: só se estorna com nota de crédito.
Por isso o fluxo é sempre **prévia → confirmação → emissão**.

## Fluxo obrigatório

### 1. Interpretar a mensagem

Cada valor é **uma venda separada**, com o seu próprio documento.

- `"15 euros de cerâmicas"` → uma venda de 15,00 de CERÂMICA
- `"15, 30 e 50 de canecas"` → **três** vendas: 15,00, 30,00 e 50,00, todas de CANECA
- `"dois cerâmicas a 20"` → uma venda, quantidade 2, preço unitário 20,00
- `"uma venda de 15 de cerâmica e 30 de caneca"` → uma venda com **dois itens**

Regra: valores soltos na mesma frase são vendas independentes, a não ser que o usuário
diga que é uma venda só ("numa nota só", "tudo junto", "uma venda de X e Y").

Se ficar em dúvida entre uma venda com vários itens e várias vendas, **pergunte**.

### 2. Mostrar a prévia

```bash
python3 /opt/weoinvoice/bin/pos-venda.py --preview '{"vendas":[{"artigo":"cerâmicas","preco":15}]}'
```

Formato do JSON:

```json
{"vendas": [
  {"artigo": "canecas", "preco": 15},
  {"artigo": "canecas", "preco": 30, "quantidade": 2},
  {"itens": [{"artigo": "cerâmica", "preco": 15}, {"artigo": "caneca", "preco": 30}]}
]}
```

- `artigo` — pode vir como o usuário escreveu; o script resolve plural, acento e caixa
- `preco` — preço unitário em euros (aceita 15 ou "15,50")
- `quantidade` — opcional, padrão 1
- `itens` — use quando várias linhas vão na **mesma** nota
- `tipoDocumento` — opcional, `"simplificada"` (padrão) ou `"factura"`
- `clienteId` — opcional; sem isto vai para o cliente de balcão

A prévia não emite nada. Mostre o resultado ao usuário e **pergunte se confirma**.

### 3. Emitir, só depois do "sim"

```bash
python3 /opt/weoinvoice/bin/pos-venda.py --emitir '{"vendas":[...]}'
```

O script envia o resumo por Telegram sozinho. Mesmo assim, responda ao usuário com os
números emitidos.

## Descobrir os artigos

```bash
python3 /opt/weoinvoice/bin/pos-venda.py --catalogo
```

Se o script disser que não encontrou um artigo, mostre a lista ao usuário e pergunte
qual é — **nunca escolha por conta própria** um artigo parecido.

## Erros

- `ARTIGO_DESCONHECIDO` — nome não bate com nada no catálogo; mostre a lista e pergunte
- `TOTAL_DIVERGENTE` — o site calculou um total diferente do pedido; **não insista**, avise o usuário
- `CARRINHO_SUJO` — sobrou item de uma tentativa anterior; avise, não force
- `AMBIGUO_VERIFICAR_LISTAGEM` — ⚠️ a fatura **pode ter sido emitida**. Nunca repita a
  emissão. Peça ao usuário para conferir no weoInvoice antes de qualquer nova tentativa.

## Notas

- Cada emissão usa uma chave de idempotência própria, então um retry acidental do mesmo
  comando não emite duas vezes.
- Um `--emitir` com várias vendas emite uma a uma. Se a terceira falhar, as duas
  primeiras **já foram emitidas** — o script diz quais.
- API: `http://localhost:8080/api/weoinvoice` (nginx local).
- Usar sempre o caminho completo `/opt/weoinvoice/bin/pos-venda.py`.
