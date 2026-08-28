/**
 * Ledger de idempotencia (R1 do plano).
 *
 * O finalize do weoInvoice nao e idempotente e o documento fiscal emitido nao
 * pode ser apagado, so estornado por nota de credito. Se a resposta do finalize
 * se perder (timeout, queda, restart), a fatura pode ter sido criada mesmo assim.
 *
 * Por isso a entrada e gravada como `finalizing` ANTES da chamada. Se o processo
 * morrer no meio, a chave fica presa nesse estado e qualquer retry e recusado em
 * vez de emitir de novo.
 *
 * Append-only JSONL: o ultimo registro de uma chave e o estado corrente.
 */

import { existsSync } from "node:fs"
import { appendFile, readFile } from "node:fs/promises"

export type LedgerState = "finalizing" | "done" | "failed"

export interface LedgerEntry {
  key: string
  state: LedgerState
  at: string
  total?: number
  resultado?: unknown
  erro?: string
}

export class Ledger {
  private cache = new Map<string, LedgerEntry>()
  private carregado = false

  constructor(private path: string) {}

  async load(): Promise<void> {
    if (this.carregado) return
    this.carregado = true
    if (!existsSync(this.path)) return
    const raw = await readFile(this.path, "utf8")
    for (const linha of raw.split("\n")) {
      const l = linha.trim()
      if (!l) continue
      try {
        const e = JSON.parse(l) as LedgerEntry
        if (e?.key) this.cache.set(e.key, e)
      } catch {
        // linha corrompida (escrita parcial num crash): ignora, o resto vale
      }
    }
  }

  get(key: string): LedgerEntry | undefined {
    return this.cache.get(key)
  }

  private async append(e: LedgerEntry) {
    this.cache.set(e.key, e)
    await appendFile(this.path, JSON.stringify(e) + "\n", "utf8")
  }

  /** Grava a intencao de emitir. Chamar SEMPRE antes do finalize. */
  async markFinalizing(key: string, total: number) {
    await this.append({ key, state: "finalizing", at: new Date().toISOString(), total })
  }

  async markDone(key: string, resultado: unknown) {
    await this.append({ key, state: "done", at: new Date().toISOString(), resultado })
  }

  /** So use quando for CERTO que nada foi emitido. Libera a chave pra retry. */
  async markFailed(key: string, erro: string) {
    await this.append({ key, state: "failed", at: new Date().toISOString(), erro })
  }
}
