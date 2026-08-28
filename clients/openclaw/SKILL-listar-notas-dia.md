---
name: pos-listar-notas-dia
description: Lista as notas emitidas num dia no weoInvoice, com o total e a divisão por tipo. Use quando o usuário perguntar quanto vendeu, o que saiu hoje, pedir o fecho do dia ou do caixa, ou chamar /pos_listar_notas_dia.
metadata: { "openclaw": { "emoji": "📊" } }
---

# Listar notas do dia — weoInvoice

Consulta o que foi emitido num dia. **Não emite nada**, não altera nada, e não precisa de
confirmação do usuário.

## Como usar

```bash
python3 /opt/weoinvoice/bin/pos-venda.py --dia            # hoje
python3 /opt/weoinvoice/bin/pos-venda.py --dia ontem
python3 /opt/weoinvoice/bin/pos-venda.py --dia 22/08      # DD/MM do ano corrente
python3 /opt/weoinvoice/bin/pos-venda.py --dia 2026-08-22
python3 /opt/weoinvoice/bin/pos-venda.py --dia -3         # três dias atrás
```

Passe a data **como o usuário disse**. O script resolve "hoje", "ontem", "anteontem",
`DD/MM`, `DD/MM/AAAA`, `AAAA-MM-DD` e número de dias atrás. Não calcule a data você mesmo:
você pode não saber o dia corrente, e errar a data num fecho de caixa passa despercebido.

## Saída

```
Documentos de 2026-08-28: 10
  2026/17      30,00 €  INDIFERENCIADO
  2026/16      25,00 €  INDIFERENCIADO
  ...
  · Factura Simplificada: 10× = 181,00 €

Total do dia: 181,00 €
```

## Como apresentar

- Comece pelo total e pela quantidade, que é o que o usuário quer saber
- Liste os documentos só se forem poucos (até uns 15) ou se ele pedir o detalhe
- Se houver mais de um tipo de documento, mostre a divisão por tipo
- Se o dia não tiver nada, diga isso de forma direta, sem tabela vazia

## Notas

- Se a data não for entendida, o script diz e não inventa: repasse a mensagem e pergunte
- Para **registar** uma venda nova, é outra skill: `pos-registrar-venda`
- API: `http://localhost:8080/api/weoinvoice/faturas/dia` (nginx local)
- Usar sempre o caminho completo `/opt/weoinvoice/bin/pos-venda.py`
