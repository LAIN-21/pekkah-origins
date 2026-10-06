// Test-only: a fresh throwaway mnemonic per run, so no mnemonic is ever written into the repo.
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const throwawayMnemonic = () => generateMnemonic(wordlist, 256);
