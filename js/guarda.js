// Criptografia (senha -> chave AES) e onde os dados ficam: repositório privado no GitHub
// ou, no modo teste (?teste), o localStorage deste navegador.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const ITERACOES = 600000;

export function b64(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function deB64(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const txtB64 = (t) => b64(enc.encode(t));
const b64Txt = (s) => dec.decode(deB64(s));

export async function chaveDaSenha(senha, sal, iteracoes = ITERACOES) {
  const base = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: deB64(sal), iterations: iteracoes, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}
export async function exportarChave(chave) {
  return b64(await crypto.subtle.exportKey('raw', chave));
}
export function importarChave(s) {
  return crypto.subtle.importKey('raw', deB64(s), 'AES-GCM', true, ['encrypt', 'decrypt']);
}
export async function cifrar(chave, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chave, bytes);
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
export async function decifrar(chave, texto) {
  const { iv, ct } = JSON.parse(texto);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(iv) }, chave, deB64(ct)));
}
export const cifrarTexto = (chave, t) => cifrar(chave, enc.encode(t));
export const decifrarTexto = async (chave, t) => dec.decode(await decifrar(chave, t));

// Config pública (vai no repositório do site): só o token cifrado e onde estão os dados.
export async function criarConfig({ token, repo, senha }) {
  const sal = b64(crypto.getRandomValues(new Uint8Array(16)));
  const chave = await chaveDaSenha(senha, sal);
  return { v: 1, repo, sal, iteracoes: ITERACOES, token: await cifrarTexto(chave, token) };
}

// ---------- GitHub ----------
export class GuardaGitHub {
  constructor(repo, token, chave) {
    this.repo = repo; this.token = token; this.chave = chave; this.shas = {};
  }
  async api(caminho, opcoes = {}) {
    const r = await fetch(`https://api.github.com/repos/${this.repo}${caminho}`, {
      cache: 'no-store',
      ...opcoes,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', ...(opcoes.headers || {}) },
    });
    return r;
  }
  async lerBruto(arquivo) {
    const r = await this.api(`/contents/${arquivo}?t=${Date.now()}`);
    if (r.status === 404) { delete this.shas[arquivo]; return null; }
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao ler ${arquivo}`);
    const j = await r.json();
    this.shas[arquivo] = j.sha;
    if (j.content) return b64Txt(j.content);
    // Arquivo maior que 1 MB vem sem conteúdo: busca pelo blob.
    const b = await this.api(`/git/blobs/${j.sha}`);
    return b64Txt((await b.json()).content);
  }
  async gravarBruto(arquivo, texto, msg) {
    const corpo = { message: msg || `atualiza ${arquivo}`, content: txtB64(texto) };
    if (this.shas[arquivo]) corpo.sha = this.shas[arquivo];
    const r = await this.api(`/contents/${arquivo}`, { method: 'PUT', body: JSON.stringify(corpo) });
    if (r.status === 409 || r.status === 422) {
      const e = new Error('conflito'); e.conflito = true; throw e;
    }
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} ao salvar`);
    this.shas[arquivo] = (await r.json()).content.sha;
  }
  async carregar() {
    const t = await this.lerBruto('dados.enc');
    return t ? JSON.parse(await decifrarTexto(this.chave, t)) : null;
  }
  async salvar(dados) {
    await this.gravarBruto('dados.enc', await cifrarTexto(this.chave, JSON.stringify(dados)), 'atualiza dados');
  }
  async salvarArquivo(nome, bytes) {
    await this.gravarBruto(`comprovantes/${nome}.enc`, await cifrar(this.chave, bytes), 'comprovante');
  }
  async lerArquivo(nome) {
    const t = await this.lerBruto(`comprovantes/${nome}.enc`);
    return t ? decifrar(this.chave, t) : null;
  }
}

// ---------- modo teste: tudo no localStorage, sem GitHub ----------
export class GuardaLocal {
  constructor(chave) { this.chave = chave; this.p = 'dnr-teste-'; }
  async carregar() {
    const t = localStorage.getItem(this.p + 'dados');
    return t ? JSON.parse(await decifrarTexto(this.chave, t)) : null;
  }
  async salvar(dados) { localStorage.setItem(this.p + 'dados', await cifrarTexto(this.chave, JSON.stringify(dados))); }
  async salvarArquivo(nome, bytes) { localStorage.setItem(this.p + 'arq-' + nome, await cifrar(this.chave, bytes)); }
  async lerArquivo(nome) {
    const t = localStorage.getItem(this.p + 'arq-' + nome);
    return t ? decifrar(this.chave, t) : null;
  }
}
