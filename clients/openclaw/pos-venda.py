#!/usr/bin/env python3
"""
pos-venda.py — lança vendas de balcão no weoInvoice a partir do Telegram.

Emite documento fiscal REAL, que não se apaga: só se estorna com nota de crédito.
Por isso o modo normal é --preview, e emitir exige --emitir explicitamente.

Uso:
    pos-venda.py --catalogo
    pos-venda.py --dia [YYYY-MM-DD]      # fecho do dia (padrão: hoje)
    pos-venda.py --preview '{"vendas":[{"artigo":"cerâmicas","preco":15}]}'
    pos-venda.py --emitir  '{"vendas":[{"artigo":"canecas","preco":15},
                                          {"artigo":"canecas","preco":30}]}'

Cada entrada em "vendas" é UMA venda separada, com o seu próprio documento.
"15, 30 e 50 de canecas" são três vendas, não três linhas de uma venda.
Para várias linhas na MESMA venda, use "itens": [...] dentro de uma venda.
"""

import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

API = "http://localhost:8080/api/weoinvoice"
GOSSIP = "http://localhost:8080/api/gossip-gate/send"
CHAVE_API = Path.home() / ".weoinvoice" / "api-key"
CHAVE_GOSSIP = Path.home() / ".gossipgate" / "api-key"


def ler_chave(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8").strip()
    except OSError as e:
        sys.exit(f"não consegui ler a chave em {p}: {e}")


def http(url: str, corpo=None, chave=None, metodo=None, timeout=90):
    dados = json.dumps(corpo).encode("utf-8") if corpo is not None else None
    req = urllib.request.Request(url, data=dados, method=metodo or ("POST" if dados else "GET"))
    req.add_header("Content-Type", "application/json")
    if chave:
        req.add_header("X-Api-Key", chave)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"sucesso": False, "erro": f"HTTP_{e.code}", "mensagem": str(e)}
    except Exception as e:
        return {"sucesso": False, "erro": "REDE", "mensagem": str(e)}


def normalizar(s: str) -> str:
    """Tira acento, caixa, pontuação e plural, para casar 'cerâmicas' com 'CERÂMICA'."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-zA-Z0-9 ]", " ", s).lower()
    s = re.sub(r"\s+", " ", s).strip()
    return " ".join(p[:-1] if len(p) > 3 and p.endswith("s") else p for p in s.split())


def resolver(artigos, termo):
    """Devolve (id, nome) ou levanta ValueError com os candidatos."""
    alvo = normalizar(termo)
    if not alvo:
        raise ValueError("nome de artigo vazio")

    exatos = [a for a in artigos if normalizar(a["nome"]) == alvo]
    if len(exatos) == 1:
        return exatos[0]["id"], exatos[0]["nome"]

    contem = [a for a in artigos if alvo in normalizar(a["nome"])]
    if len(contem) == 1:
        return contem[0]["id"], contem[0]["nome"]

    candidatos = exatos or contem
    if candidatos:
        raise ValueError(f"'{termo}' é ambíguo: " + ", ".join(a["nome"] for a in candidatos))
    raise ValueError(
        f"não encontrei '{termo}' no catálogo. Artigos: " + ", ".join(a["nome"] for a in artigos)
    )


def euros(v) -> str:
    return f"{float(v):.2f}".replace(".", ",") + " €"


def carregar_vendas(bruto: str):
    try:
        d = json.loads(bruto)
    except json.JSONDecodeError as e:
        sys.exit(f"JSON inválido: {e}")
    vendas = d.get("vendas") if isinstance(d, dict) else None
    if not isinstance(vendas, list) or not vendas:
        sys.exit('esperado {"vendas":[...]} com pelo menos uma venda')
    return vendas


def montar_itens(venda, artigos):
    """Uma venda pode ter um artigo só ou vários itens."""
    brutos = venda.get("itens") or [venda]
    itens = []
    for b in brutos:
        preco = b.get("preco", b.get("precoUnitario"))
        if preco is None:
            raise ValueError("falta o preço")
        preco = float(str(preco).replace(",", "."))
        if preco <= 0:
            raise ValueError(f"preço inválido: {preco}")
        qtd = int(b.get("quantidade", 1))
        artigo_id, nome = resolver(artigos, b.get("artigo") or b.get("artigoId") or "")
        itens.append({"artigoId": artigo_id, "precoUnitario": preco, "quantidade": qtd, "_nome": nome})
    return itens


def executar(vendas, artigos, chave, emitir: bool):
    resultados = []
    carimbo = int(time.time())

    for i, venda in enumerate(vendas, 1):
        try:
            itens = montar_itens(venda, artigos)
        except ValueError as e:
            resultados.append({"i": i, "ok": False, "erro": str(e)})
            print(f"  {i}. ✖ {e}")
            continue

        pedido = {
            "itens": [{k: v for k, v in it.items() if not k.startswith("_")} for it in itens],
            "tipoDocumento": venda.get("tipoDocumento", "simplificada"),
            "dryRun": not emitir,
        }
        if venda.get("clienteId"):
            pedido["clienteId"] = venda["clienteId"]
        if emitir:
            pedido["idempotencyKey"] = f"telegram-{carimbo}-{i}"

        r = http(f"{API}/pos/sale", pedido, chave)
        descricao = " + ".join(
            f"{it['quantidade']}× {it['_nome']} a {euros(it['precoUnitario'])}" for it in itens
        )

        if r.get("sucesso"):
            total = euros(r.get("total", 0))
            numero = r.get("numero") or "(sem número)"
            if emitir:
                print(f"  {i}. ✅ {numero} — {descricao} = {total}")
            else:
                print(f"  {i}. ▸ {descricao} = {total}")
            resultados.append({"i": i, "ok": True, "numero": r.get("numero"), "total": r.get("total"), "desc": descricao})
        else:
            msg = r.get("mensagem", "erro desconhecido")
            print(f"  {i}. ✖ {r.get('erro')}: {msg}")
            resultados.append({"i": i, "ok": False, "erro": f"{r.get('erro')}: {msg}", "desc": descricao})
            if r.get("erro") == "AMBIGUO_VERIFICAR_LISTAGEM":
                print("     ⚠️  PODE TER SIDO EMITIDA. Conferir a listagem antes de repetir.")

    return resultados


def notificar(resultados):
    ok = [r for r in resultados if r["ok"]]
    falhas = [r for r in resultados if not r["ok"]]
    if not ok and not falhas:
        return
    linhas = [f"🧾 *weoInvoice* — {len(ok)} venda(s) registada(s)"]
    for r in ok:
        linhas.append(f"✅ {r.get('numero') or '?'} — {r['desc']} = {euros(r.get('total', 0))}")
    for r in falhas:
        linhas.append(f"❌ {r.get('desc', '')}: {r['erro']}")
    total = sum(float(r.get("total") or 0) for r in ok)
    if len(ok) > 1:
        linhas.append(f"— total: {euros(total)}")
    http(GOSSIP, {"message": "\n".join(linhas)}, ler_chave(CHAVE_GOSSIP))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    modo = sys.argv[1]
    chave = ler_chave(CHAVE_API)

    if modo == "--dia":
        data = sys.argv[2] if len(sys.argv) > 2 else "hoje"
        d = http(f"{API}/faturas/dia?data={data}", chave=chave)
        if not d.get("sucesso"):
            sys.exit(f"erro: {d.get('mensagem', d)}")
        print(f"Documentos de {d['data']}: {d['quantidade']}")
        for f in d.get("faturas", []):
            print(f"  {f['numero']:<9} {euros(f.get('total', 0)):>10}  {f.get('cliente', '')}")
        for tipo, v in (d.get("porTipo") or {}).items():
            print(f"  · {tipo}: {v['quantidade']}× = {euros(v['total'])}")
        print(f"\nTotal do dia: {euros(d['total'])}")
        return

    cat = http(f"{API}/catalogo", chave=chave)
    if not cat.get("sucesso"):
        sys.exit(f"não consegui ler o catálogo: {cat.get('mensagem', cat)}")
    artigos = cat["artigos"]

    if modo == "--catalogo":
        print("Artigos disponíveis:")
        for a in artigos:
            print(f"  {a['nome']}")
        return

    if modo not in ("--preview", "--emitir"):
        sys.exit(f"modo desconhecido: {modo}")

    if len(sys.argv) < 3:
        sys.exit("falta o JSON das vendas")

    vendas = carregar_vendas(sys.argv[2])
    emitir = modo == "--emitir"

    print(f"{'EMITINDO' if emitir else 'PRÉVIA (nada é emitido)'} — {len(vendas)} venda(s):")
    resultados = executar(vendas, artigos, chave, emitir)

    ok = [r for r in resultados if r["ok"]]
    total = sum(float(r.get("total") or 0) for r in ok)
    print(f"\n{len(ok)}/{len(resultados)} ok — total {euros(total)}")

    if emitir:
        notificar(resultados)
    else:
        print("\nPara emitir de verdade, repita com --emitir.")

    sys.exit(0 if len(ok) == len(resultados) else 1)


if __name__ == "__main__":
    main()
