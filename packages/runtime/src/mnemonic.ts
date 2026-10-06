import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

/**
 * The form both the check and the wallet libraries use: lowercase words joined by single
 * spaces. Extra whitespace would otherwise change the seed a library derives.
 */
export function normalizeMnemonic(value: string): string {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * What is wrong with a BIP-39 mnemonic, described by position only. Never include the words:
 * wallet libraries put the offending word in their errors, so mnemonics are checked here,
 * before any library sees them.
 */
export function mnemonicProblem(value: string): string | null {
  const words = normalizeMnemonic(value).split(" ").filter(Boolean);
  if (!WORD_COUNTS.has(words.length)) {
    return `has ${words.length} words; a mnemonic has 12, 15, 18, 21 or 24`;
  }
  const unknown = words.flatMap((word, i) => (wordlist.includes(word) ? [] : [i + 1]));
  if (unknown.length === 1) {
    return `word ${unknown[0]} of ${words.length} is not in the BIP-39 English wordlist`;
  }
  if (unknown.length > 1) {
    return `words ${unknown.join(", ")} of ${words.length} are not in the BIP-39 English wordlist`;
  }
  if (!validateMnemonic(words.join(" "), wordlist)) {
    return "fails the BIP-39 checksum (a word replaced, or the words out of order)";
  }
  return null;
}

/**
 * Throws a message that names the variable and the problem, never the words. Returns the
 * normalized mnemonic: pass that, not the raw value, to the wallet library.
 */
export function assertMnemonic(name: string, value: string): string {
  const problem = mnemonicProblem(value);
  if (problem) throw new Error(`${name} ${problem}`);
  return normalizeMnemonic(value);
}
