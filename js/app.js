import {
  TIPOS, PERIODOS, r2, gerarCronograma, estadoContrato, taxaMensalAprox, extenso, hojeISO, difDias, somaMeses,
} from './calc.js';
import {
  GuardaGitHub, GuardaLocal, chaveDaSenha, criarConfig, decifrarTexto, exportarChave, importarChave,
} from './guarda.js';

const MODO_TESTE = new URLSearchParams(location.search).has('teste');
const LIMITE_USURA = 1; // % ao mês (Decreto 22.626/33, entre pessoas físicas)

const MSG_LEMBRETE = 'Oi {nome}, tudo bem? Passando para lembrar da parcela de {valor} que vence {quando}.\nPix: {pix}';
const MSG_ATRASO = 'Oi {nome}, tudo bem? Tem {parcelas} em aberto desde {vencimento}, {dias} de atraso. Com multa e juros, hoje fica {valor}.\nConsegue acertar hoje? Pix: {pix}';

const novoBanco = () => ({
  v: 1,
  config: { credor: '', cpfCredor: '', cidade: '', pix: '', multa: 2, mora: 1, tolerancia: 0, msgLembrete: MSG_LEMBRETE, msgAtraso: MSG_ATRASO, reciboN: 0 },
  devedores: [], contratos: [], pagamentos: [],
});

let D = null;          // os dados
let guarda = null;     // onde salvar
let E = new Map();     // estado calculado de cada contrato
let HOJE = hojeISO();
let salvando = false, pendente = false, erroSalvar = false;

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (s) => (s ? s.split('-').reverse().join('/') : '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (s) => {
  if (typeof s === 'number') return s;
  let t = String(s || '').replace(/[^\d,.-]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return Number(t) || 0;
};
const devedor = (id) => D.devedores.find((d) => d.id === id);
const contrato = (id) => D.contratos.find((c) => c.id === id);
const primeiroNome = (n) => String(n || '').trim().split(/[\s(]/)[0];
const ativo = (c) => !['cancelado', 'perdido'].includes(c.status);
function quando(venc) {
  const d = difDias(venc, HOJE);
  if (d === 0) return 'hoje';
  if (d === 1) return 'amanhã';
  return `em ${dataBR(venc).slice(0, 5)}`;
}
function formDados(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    o[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return o;
}

function calcular() {
  HOJE = hojeISO();
  E = new Map();
  for (const c of D.contratos) E.set(c.id, estadoContrato(c, D.pagamentos, HOJE));
}

// Parcelas em aberto de contratos ativos, para painel e cobrança.
function parcelasAbertas() {
  const out = [];
  for (const c of D.contratos) {
    if (!ativo(c)) continue;
    const e = E.get(c.id);
    for (const p of e.parcelas) if (p.status !== 'pago') out.push({ c, p, d: devedor(c.devedorId) });
  }
  return out.sort((a, b) => difDias(a.p.venc, b.p.venc));
}

function totalDevedor(id) {
  let aberto = 0, atrasado = 0;
  for (const c of D.contratos) {
    if (c.devedorId !== id || !ativo(c)) continue;
    const e = E.get(c.id);
    aberto += e.emAberto; atrasado += e.atrasado;
  }
  return { aberto: r2(aberto), atrasado: r2(atrasado) };
}

// ---------- salvar ----------
function mudou() {
  calcular();
  desenhar();
  pendente = true;
  salvarJa();
}
async function salvarJa() {
  if (salvando) return;
  salvando = true; pendente = false; erroSalvar = false; marcarSalvo();
  try {
    await guarda.salvar(D);
  } catch (e) {
    if (e.conflito) {
      alert('Os dados foram mudados em outro aparelho. Vou carregar a versão mais nova. Confira a última alteração.');
      D = (await guarda.carregar()) || D;
      calcular(); desenhar();
    } else {
      erroSalvar = true; pendente = true;
      console.error(e);
    }
  }
  salvando = false; marcarSalvo();
  if (pendente && !erroSalvar) salvarJa();
}
function marcarSalvo() {
  const el = $('#estado-salvo');
  if (!el) return;
  el.className = 'estado-salvo' + (erroSalvar ? ' erro' : '');
  el.textContent = erroSalvar ? 'Não salvou. Tocar para tentar' : salvando || pendente ? 'Salvando…' : MODO_TESTE ? 'Modo teste' : 'Salvo';
}
addEventListener('beforeunload', (e) => { if (salvando || pendente) { e.preventDefault(); e.returnValue = ''; } });

// ---------- entrada ----------
async function lerConfig() {
  try {
    const r = await fetch('config.json', { cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch { /* sem config publicada */ }
  const local = localStorage.getItem('dnr-config');
  return local ? JSON.parse(local) : null;
}

async function iniciar() {
  if (MODO_TESTE) return telaEntrada(null);
  const cfg = await lerConfig();
  if (!cfg) return telaConfigurar();
  const lembrada = localStorage.getItem('dnr-chave');
  if (lembrada) {
    try { return await abrir(cfg, await importarChave(lembrada)); } catch { localStorage.removeItem('dnr-chave'); }
  }
  telaEntrada(cfg);
}

function telaEntrada(cfg) {
  $('#app').innerHTML = `
    <div class="entrada">
      <h1>Dinheiro na <span>Rua</span></h1>
      <p class="fraco">${MODO_TESTE ? 'Modo teste: os dados ficam só neste navegador. Qualquer senha entra.' : 'Recebimentos e empréstimos.'}</p>
      <form id="form-entrada">
        <label>Senha<input type="password" name="senha" autocomplete="current-password" required autofocus></label>
        <label class="marcar"><input type="checkbox" name="lembrar"> Manter conectado neste aparelho</label>
        <button class="bt prim" type="submit">Entrar</button>
        <p id="msg-entrada" class="fraco peq"></p>
      </form>
    </div>`;
  $('#form-entrada').onsubmit = async (ev) => {
    ev.preventDefault();
    const { senha, lembrar } = formDados(ev.target);
    const msg = $('#msg-entrada');
    msg.textContent = 'Abrindo…';
    try {
      const chave = MODO_TESTE
        ? await chaveDaSenha('teste', 'dGVzdGVkaW5oZWlyb25hcnVh', 1000)
        : await chaveDaSenha(senha, cfg.sal, cfg.iteracoes);
      await abrir(cfg, chave);
      if (lembrar) localStorage.setItem('dnr-chave', await exportarChave(chave));
    } catch (e) {
      console.error(e);
      msg.textContent = e.senhaErrada ? 'Senha errada.' : `Não abriu: ${e.message}`;
    }
  };
}

async function abrir(cfg, chave) {
  if (MODO_TESTE) {
    guarda = new GuardaLocal(chave);
  } else {
    let token;
    try { token = await decifrarTexto(chave, cfg.token); } catch { const e = new Error('senha'); e.senhaErrada = true; throw e; }
    guarda = new GuardaGitHub(cfg.repo, token, chave);
  }
  D = (await guarda.carregar()) || novoBanco();
  D.config = { ...novoBanco().config, ...D.config };
  calcular();
  if (!location.hash) location.hash = '#/painel';
  desenhar();
}

function telaConfigurar() {
  $('#app').innerHTML = `
    <div class="entrada" style="max-width:520px;margin-top:6vh">
      <h1>Dinheiro na <span>Rua</span></h1>
      <p class="fraco">Primeira configuração. Os dados vão ficar num repositório privado do GitHub, criptografados com a senha. Sem a senha, ninguém lê.</p>
      <form id="form-config">
        <label>Repositório dos dados (dono/nome)<input name="repo" placeholder="usuario/dinheiro-na-rua-dados" required></label>
        <label>Token do GitHub (fine-grained, só esse repositório, Contents: leitura e escrita)<input name="token" required autocomplete="off"></label>
        <label>Senha de acesso<input type="password" name="senha" minlength="8" required autocomplete="new-password"></label>
        <label>Repita a senha<input type="password" name="senha2" required autocomplete="new-password"></label>
        <button class="bt prim" type="submit">Testar e gerar</button>
        <p id="msg-config" class="fraco peq"></p>
      </form>
      <div id="saida-config"></div>
    </div>`;
  $('#form-config').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = formDados(ev.target);
    const msg = $('#msg-config');
    if (f.senha !== f.senha2) { msg.textContent = 'As senhas não batem.'; return; }
    msg.textContent = 'Testando o acesso ao repositório…';
    const r = await fetch(`https://api.github.com/repos/${f.repo}`, { headers: { Authorization: `Bearer ${f.token}` } });
    if (!r.ok) { msg.textContent = `O token não abriu o repositório (GitHub respondeu ${r.status}).`; return; }
    msg.textContent = 'Gerando a chave (leva alguns segundos)…';
    const cfg = await criarConfig({ token: f.token, repo: f.repo, senha: f.senha });
    localStorage.setItem('dnr-config', JSON.stringify(cfg));
    const texto = JSON.stringify(cfg, null, 2);
    msg.textContent = '';
    $('#saida-config').innerHTML = `
      <div class="aviso verde">Pronto. Já funciona neste aparelho. Para entrar de qualquer celular, o arquivo abaixo vai como <b>config.json</b> no repositório do site. Ele não tem nada legível sem a senha.</div>
      <textarea readonly style="min-height:160px;font-size:12px">${esc(texto)}</textarea>
      <div class="linha-acoes"><a class="bt" download="config.json" href="data:application/json;charset=utf-8,${encodeURIComponent(texto)}">Baixar config.json</a>
      <button class="bt prim" onclick="location.reload()">Entrar</button></div>`;
  };
}

// ---------- desenho ----------
const ABAS = [
  ['painel', '◉', 'Painel'], ['cobrar', '☎', 'Cobrar'], ['pessoas', '☺', 'Pessoas'], ['contratos', '≡', 'Contratos'], ['mais', '⚙', 'Mais'],
];

function desenhar() {
  if (!D) return;
  const [rota, id] = location.hash.replace(/^#\/?/, '').split('/');
  const telas = { painel: telaPainel, cobrar: telaCobrar, pessoas: telaPessoas, pessoa: telaPessoa, contratos: telaContratos, contrato: telaContrato, mais: telaMais };
  const tela = telas[rota] || telaPainel;
  const aba = { pessoa: 'pessoas', contrato: 'contratos' }[rota] || rota || 'painel';
  const rolagem = scrollY;
  $('#app').innerHTML = `
    <header class="topo"><h1>Dinheiro na <span>Rua</span></h1><span id="estado-salvo" class="estado-salvo" data-acao="tentarSalvar"></span></header>
    <main>${tela(id)}</main>
    <nav class="abas">${ABAS.map(([r, i, n]) => `<a href="#/${r}" class="${aba === r ? 'ativa' : ''}"><b>${i}</b>${n}</a>`).join('')}</nav>`;
  marcarSalvo();
  if (desenhar.ultimaRota === location.hash) scrollTo(0, rolagem); else scrollTo(0, 0);
  desenhar.ultimaRota = location.hash;
  const busca = $('#busca');
  if (busca && desenhar.busca) { busca.value = desenhar.busca; busca.focus(); filtrarBusca(); }
}
addEventListener('hashchange', () => { desenhar.busca = ''; desenhar(); });

const etq = (s) => `<span class="etq ${s.replace(' ', '-')}">${{ hoje: 'vence hoje', aberto: 'a vencer' }[s] || s}</span>`;

function itemParcela({ c, p, d }) {
  const det = p.status === 'atrasado' ? `venceu ${dataBR(p.venc)} · ${p.diasAtraso} ${p.diasAtraso === 1 ? 'dia' : 'dias'}` : `vence ${dataBR(p.venc)}`;
  return `<div class="item">
    <a class="corpo" href="#/contrato/${c.id}" style="text-decoration:none;color:inherit">
      <div class="nome">${esc(d?.nome || '?')}</div>
      <div class="det">${esc(c.descricao || TIPOS[c.tipo])} · ${p.n}/${c.cronograma.length} · ${det}</div>
    </a>
    <div class="dir"><div class="valor">${brl(p.devido)}</div>${p.encargo > 0 ? `<div class="det">com ${brl(p.encargo)} de juros</div>` : ''}</div>
    <div class="botoes">
      ${d?.telefone ? `<button class="bt zap peq" data-acao="zap" data-devedor="${d.id}" title="Cobrar no WhatsApp">Zap</button>` : ''}
      <button class="bt peq" data-acao="receber" data-contrato="${c.id}">Receber</button>
    </div>
  </div>`;
}

function telaPainel() {
  const abertas = parcelasAbertas();
  const atrasadas = abertas.filter((x) => x.p.status === 'atrasado');
  const hoje = abertas.filter((x) => x.p.status === 'hoje');
  const semana = abertas.filter((x) => { const d = difDias(x.p.venc, HOJE); return d > 0 && d <= 7; });
  let aReceber = 0, naRua = 0, lucro = 0, lucroPrev = 0;
  for (const c of D.contratos) {
    const e = E.get(c.id);
    lucro += e.lucro;
    if (!ativo(c)) continue;
    aReceber += e.emAberto; naRua += e.naRua; lucroPrev += Math.max(e.lucroPrevisto - e.lucro, 0);
  }
  const mes = HOJE.slice(0, 7);
  const recebidoMes = D.pagamentos.filter((x) => x.data.startsWith(mes)).reduce((s, x) => s + num(x.valor), 0);
  const totalAtrasado = atrasadas.reduce((s, x) => s + x.p.devido, 0);
  const pessoasAtraso = new Set(atrasadas.map((x) => x.c.devedorId)).size;
  const sec = (titulo, lista, vazio) => `<h2>${titulo}</h2>${lista.length ? `<div class="lista">${lista.map(itemParcela).join('')}</div>` : `<div class="vazio">${vazio}</div>`}`;
  return `
    <div class="numeros">
      <div class="numero"><small>A receber</small><strong>${brl(aReceber)}</strong></div>
      <div class="numero vermelho"><small>Atrasado · ${pessoasAtraso} ${pessoasAtraso === 1 ? 'pessoa' : 'pessoas'}</small><strong>${brl(totalAtrasado)}</strong></div>
      <div class="numero amarelo"><small>Capital na rua</small><strong>${brl(naRua)}</strong></div>
      <div class="numero verde"><small>Recebido no mês</small><strong>${brl(recebidoMes)}</strong></div>
      <div class="numero verde"><small>Lucro já recebido</small><strong>${brl(lucro)}</strong></div>
      <div class="numero"><small>Lucro ainda por vir</small><strong>${brl(lucroPrev)}</strong></div>
    </div>
    <div class="linha-acoes">
      <button class="bt prim" data-acao="novoContrato">+ Novo empréstimo</button>
      <button class="bt" data-acao="receber">Registrar pagamento</button>
    </div>
    ${sec('Atrasados', atrasadas, 'Ninguém atrasado.')}
    ${sec('Vencem hoje', hoje, 'Nada vence hoje.')}
    ${sec('Próximos 7 dias', semana, 'Nada nos próximos 7 dias.')}`;
}

// ---------- cobrança ----------
function cobrancasPorPessoa() {
  const mapa = new Map();
  for (const x of parcelasAbertas()) {
    const dias = difDias(x.p.venc, HOJE);
    if (dias > 3) continue;
    const id = x.c.devedorId;
    if (!mapa.has(id)) mapa.set(id, { d: x.d, atrasadas: [], proximas: [] });
    mapa.get(id)[dias < 0 ? 'atrasadas' : 'proximas'].push(x);
  }
  return [...mapa.values()].sort((a, b) => (b.atrasadas.length ? 1 : 0) - (a.atrasadas.length ? 1 : 0)
    || b.atrasadas.reduce((s, x) => s + x.p.devido, 0) - a.atrasadas.reduce((s, x) => s + x.p.devido, 0));
}

function mensagemCobranca(g) {
  const cfg = D.config;
  const usar = g.atrasadas.length ? g.atrasadas : g.proximas;
  const valor = usar.reduce((s, x) => s + x.p.devido, 0);
  const maisVelha = usar[0].p;
  const modelo = g.atrasadas.length ? cfg.msgAtraso : cfg.msgLembrete;
  const troca = {
    nome: primeiroNome(g.d?.nome), valor: brl(valor), vencimento: dataBR(maisVelha.venc), dias: `${maisVelha.diasAtraso} ${maisVelha.diasAtraso === 1 ? 'dia' : 'dias'}`,
    parcela: `${maisVelha.n}/${usar[0].c.cronograma.length}`, parcelas: usar.length === 1 ? '1 parcela' : `${usar.length} parcelas`, pix: cfg.pix, quando: quando(maisVelha.venc),
  };
  return modelo.replace(/\{(\w+)\}/g, (m, k) => (k in troca ? troca[k] : m))
    .split('\n').filter((l) => !/:\s*$/.test(l)).join('\n');
}

function linkZap(telefone, texto) {
  let n = String(telefone || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return `https://wa.me/${n}?text=${encodeURIComponent(texto)}`;
}

function telaCobrar() {
  const grupos = cobrancasPorPessoa();
  return `
    <h2>Cobrar</h2>
    <p class="fraco peq">Quem está atrasado aparece primeiro, depois quem vence nos próximos 3 dias. O botão abre o WhatsApp com a mensagem pronta e você confere antes de enviar. A mensagem se muda em Mais.</p>
    ${grupos.length ? `<div class="lista">${grupos.map((g) => {
      const atrasado = g.atrasadas.reduce((s, x) => s + x.p.devido, 0);
      const prox = g.proximas.reduce((s, x) => s + x.p.devido, 0);
      const cobrado = g.d?.ultimaCobranca === HOJE;
      return `<div class="item">
        <a class="corpo" href="#/pessoa/${g.d?.id}" style="text-decoration:none;color:inherit">
          <div class="nome">${esc(g.d?.nome)}</div>
          <div class="det">${g.atrasadas.length ? `${g.atrasadas.length} atrasada${g.atrasadas.length > 1 ? 's' : ''}, desde ${dataBR(g.atrasadas[0].p.venc)}` : `vence ${quando(g.proximas[0].p.venc)}`}${cobrado ? ' · <b style="color:var(--verde)">cobrado hoje</b>' : g.d?.ultimaCobranca ? ` · cobrado em ${dataBR(g.d.ultimaCobranca)}` : ''}</div>
        </a>
        <div class="dir"><div class="valor" style="color:${atrasado ? 'var(--vermelho)' : 'inherit'}">${brl(atrasado || prox)}</div></div>
        <div class="botoes">${g.d?.telefone ? `<button class="bt zap peq" data-acao="zap" data-devedor="${g.d.id}">${g.atrasadas.length ? 'Cobrar' : 'Lembrar'}</button>` : '<span class="fraco peq">sem telefone</span>'}</div>
      </div>`;
    }).join('')}</div>` : '<div class="vazio">Ninguém para cobrar agora.</div>'}`;
}

// ---------- pessoas ----------
function telaPessoas() {
  const lista = [...D.devedores].sort((a, b) => totalDevedor(b.id).atrasado - totalDevedor(a.id).atrasado || a.nome.localeCompare(b.nome));
  return `
    <h2>Pessoas</h2>
    <div class="linha-acoes"><button class="bt prim" data-acao="editarPessoa">+ Nova pessoa</button></div>
    <input id="busca" class="busca" placeholder="Buscar por nome, apelido ou telefone" data-acao-input="busca">
    ${lista.length ? `<div class="lista" id="lista-busca">${lista.map((d) => {
      const t = totalDevedor(d.id);
      return `<a class="item" href="#/pessoa/${d.id}" data-busca="${esc([d.nome, d.apelido, d.telefone, d.indicacao].join(' ').toLowerCase())}">
        <div class="corpo"><div class="nome">${esc(d.nome)}${d.apelido ? ` <span class="fraco">(${esc(d.apelido)})</span>` : ''}</div>
        <div class="det">${esc(d.telefone || 'sem telefone')}${d.indicacao ? ` · indicação: ${esc(d.indicacao)}` : ''}</div></div>
        <div class="dir"><div class="valor">${brl(t.aberto)}</div>${t.atrasado ? `<div class="det" style="color:var(--vermelho)">${brl(t.atrasado)} atrasado</div>` : ''}</div>
      </a>`;
    }).join('')}</div>` : '<div class="vazio">Nenhuma pessoa cadastrada.</div>'}`;
}
function filtrarBusca() {
  const q = ($('#busca')?.value || '').toLowerCase().trim();
  desenhar.busca = q;
  document.querySelectorAll('#lista-busca [data-busca]').forEach((el) => { el.style.display = el.dataset.busca.includes(q) ? '' : 'none'; });
}

function telaPessoa(id) {
  const d = devedor(id);
  if (!d) return '<div class="vazio">Pessoa não encontrada.</div>';
  const cs = D.contratos.filter((c) => c.devedorId === id);
  const pgs = D.pagamentos.filter((p) => cs.some((c) => c.id === p.contratoId)).sort((a, b) => difDias(b.data, a.data));
  const t = totalDevedor(id);
  const campo = (n, v) => (v ? `<div><small>${n}</small>${esc(v)}</div>` : '');
  return `
    <a class="voltar" href="#/pessoas">‹ Pessoas</a>
    <h2>${esc(d.nome)}</h2>
    <div class="caixa grade2">
      ${campo('Apelido', d.apelido)}${campo('CPF', d.cpf)}${campo('Telefone', d.telefone)}${campo('Endereço', d.endereco)}
      ${campo('Indicação', d.indicacao)}${campo('Observações', d.obs)}
      <div><small>Em aberto</small><b>${brl(t.aberto)}</b></div>
      <div><small>Atrasado</small><b style="color:${t.atrasado ? 'var(--vermelho)' : 'inherit'}">${brl(t.atrasado)}</b></div>
    </div>
    <div class="linha-acoes">
      <button class="bt prim" data-acao="novoContrato" data-devedor="${d.id}">+ Empréstimo</button>
      ${d.telefone ? `<button class="bt zap" data-acao="zap" data-devedor="${d.id}">WhatsApp</button>` : ''}
      <button class="bt" data-acao="editarPessoa" data-devedor="${d.id}">Editar</button>
    </div>
    <h3>Empréstimos</h3>
    ${cs.length ? `<div class="lista">${cs.map(itemContrato).join('')}</div>` : '<div class="vazio">Nenhum empréstimo.</div>'}
    <h3>Pagamentos</h3>
    ${pgs.length ? tabelaPagamentos(pgs, true) : '<div class="vazio">Nenhum pagamento.</div>'}`;
}

// ---------- contratos ----------
function itemContrato(c) {
  const e = E.get(c.id);
  const d = devedor(c.devedorId);
  const prox = e.proxima ? ` · próxima ${dataBR(e.proxima.venc)}` : '';
  return `<a class="item" href="#/contrato/${c.id}" data-busca="${esc([d?.nome, c.descricao].join(' ').toLowerCase())}">
    <div class="corpo"><div class="nome">${esc(d?.nome || '?')} · ${brl(c.valor)}</div>
    <div class="det">${esc(c.descricao || TIPOS[c.tipo])} · ${c.cronograma.length}x · desde ${dataBR(c.dataEmprestimo)}${prox}</div></div>
    <div class="dir"><div class="valor">${brl(e.emAberto)}</div>${etq(e.situacao)}</div>
  </a>`;
}

function telaContratos() {
  const filtro = desenhar.filtro || 'abertos';
  const filtros = { abertos: 'Em aberto', atrasado: 'Atrasados', quitado: 'Quitados', todos: 'Todos' };
  const lista = D.contratos.filter((c) => {
    const s = E.get(c.id).situacao;
    if (filtro === 'abertos') return s === 'em dia' || s === 'atrasado';
    if (filtro === 'todos') return true;
    return s === filtro;
  }).sort((a, b) => difDias(b.dataEmprestimo, a.dataEmprestimo));
  return `
    <h2>Empréstimos</h2>
    <div class="linha-acoes">
      <button class="bt prim" data-acao="novoContrato">+ Novo empréstimo</button>
      ${Object.entries(filtros).map(([k, n]) => `<button class="bt peq ${k === filtro ? 'prim' : ''}" data-acao="filtro" data-filtro="${k}">${n}</button>`).join('')}
    </div>
    <input id="busca" class="busca" placeholder="Buscar" data-acao-input="busca">
    ${lista.length ? `<div class="lista" id="lista-busca">${lista.map(itemContrato).join('')}</div>` : '<div class="vazio">Nada aqui.</div>'}`;
}

function tabelaPagamentos(pgs, comContrato) {
  return `<div class="rolagem"><table class="tabela">
    <tr><th>Data</th>${comContrato ? '<th>Empréstimo</th>' : ''}<th class="dir">Valor</th><th>Abateu</th><th></th></tr>
    ${pgs.map((p) => {
      const c = contrato(p.contratoId);
      const ap = E.get(p.contratoId)?.aplicacoes[p.id] || [];
      const abateu = ap.map((a) => `parc. ${a.n}${a.encargo ? ` (${brl(a.encargo)} juros)` : ''}`).join(', ')
        + (p.isentar ? ' · sem juros' : '') + (p.quitacao ? ' · quitação' : '');
      return `<tr>
        <td>${dataBR(p.data)}<div class="fraco peq">${esc(p.forma || '')}</div></td>
        ${comContrato ? `<td><a href="#/contrato/${c?.id}">${esc(c?.descricao || brl(c?.valor))}</a></td>` : ''}
        <td class="dir"><b>${brl(p.valor)}</b></td>
        <td class="peq">${abateu || '<span class="fraco">sobra</span>'}${p.obs ? `<div class="fraco">${esc(p.obs)}</div>` : ''}</td>
        <td class="dir" style="white-space:nowrap">
          <button class="bt peq" data-acao="recibo" data-pagamento="${p.id}">Recibo</button>
          ${p.comprovante ? `<button class="bt peq" data-acao="verComprovante" data-pagamento="${p.id}">Foto</button>` : ''}
          <button class="bt peq perigo" data-acao="apagarPagamento" data-pagamento="${p.id}" title="Apagar">×</button>
        </td>
      </tr>`;
    }).join('')}
  </table></div>`;
}

function telaContrato(id) {
  const c = contrato(id);
  if (!c) return '<div class="vazio">Empréstimo não encontrado.</div>';
  const e = E.get(id);
  const d = devedor(c.devedorId);
  const pgs = D.pagamentos.filter((p) => p.contratoId === id).sort((a, b) => difDias(a.data, b.data));
  const taxaMes = taxaMensalAprox(c);
  const taxaTxt = c.tipo === 'combinado' ? `${brl(c.total)} a receber` : `${String(c.taxa).replace('.', ',')}% ${PERIODOS[c.periodo].taxa}`;
  return `
    <a class="voltar" href="#/pessoa/${d?.id}">‹ ${esc(d?.nome)}</a>
    <h2>${esc(c.descricao || TIPOS[c.tipo])} ${etq(e.situacao)}</h2>
    <div class="caixa grade2">
      <div><small>Emprestado em ${dataBR(c.dataEmprestimo)}</small><b>${brl(c.valor)}</b></div>
      <div><small>${TIPOS[c.tipo]}</small>${taxaTxt}</div>
      <div><small>Parcelas</small>${c.cronograma.length}x ${PERIODOS[c.periodo].nome.toLowerCase()}</div>
      <div><small>Total combinado</small>${brl(e.totalContratado)}</div>
      <div><small>Recebido</small><b style="color:var(--verde)">${brl(e.recebido)}</b></div>
      <div><small>Em aberto hoje</small><b>${brl(e.emAberto)}</b></div>
      <div><small>Para quitar hoje</small>${brl(e.quitarHoje)}</div>
      <div><small>Lucro recebido / previsto</small>${brl(e.lucro)} / ${brl(e.lucroPrevisto)}</div>
      <div><small>Atraso</small>multa ${c.multa}% + ${c.mora}% ao mês${c.tolerancia ? `, ${c.tolerancia} dias de carência` : ''}</div>
      ${e.desconto ? `<div><small>Descontos dados</small>${brl(e.desconto)}</div>` : ''}
      ${e.excedente ? `<div><small>Pago a mais</small>${brl(e.excedente)}</div>` : ''}
    </div>
    ${c.obs ? `<p class="fraco peq">${esc(c.obs)}</p>` : ''}
    ${taxaMes > LIMITE_USURA ? `<div class="aviso">Juros de cerca de ${taxaMes.toFixed(1).replace('.', ',')}% ao mês. Entre pessoas físicas, acima de 1% ao mês pode ser considerado usura (Decreto 22.626/33) e não vale numa cobrança na Justiça.</div>` : ''}
    <div class="linha-acoes">
      ${ativo(c) && !e.quitado ? `<button class="bt prim" data-acao="receber" data-contrato="${id}">Registrar pagamento</button>
      <button class="bt" data-acao="receber" data-contrato="${id}" data-quitar="1">Quitar tudo</button>` : ''}
      ${d?.telefone && !e.quitado ? `<button class="bt zap" data-acao="zap" data-devedor="${d.id}">Cobrar</button>` : ''}
      <button class="bt" data-acao="novoContrato" data-editar="${id}">Editar</button>
      <button class="bt perigo" data-acao="apagarContrato" data-contrato="${id}">Apagar</button>
    </div>
    <h3>Parcelas</h3>
    <div class="rolagem"><table class="tabela">
      <tr><th>#</th><th>Vencimento</th><th class="dir">Parcela</th><th class="dir">Falta</th><th>Situação</th></tr>
      ${e.parcelas.map((p) => `<tr>
        <td>${p.n}</td><td>${dataBR(p.venc)}</td>
        <td class="dir">${brl(p.valor)}<div class="fraco peq">${p.juros ? `juros ${brl(p.juros)}` : ''}</div></td>
        <td class="dir">${p.status === 'pago' ? '<span class="fraco">pago ' + dataBR(p.pagoEm).slice(0, 5) + '</span>' : `<b>${brl(p.devido)}</b>${p.encargo ? `<div class="peq" style="color:var(--vermelho)">+${brl(p.encargo)} atraso</div>` : ''}`}</td>
        <td>${etq(p.status)}${p.status === 'atrasado' ? `<div class="fraco peq">${p.diasAtraso} ${p.diasAtraso === 1 ? 'dia' : 'dias'}</div>` : ''}</td>
      </tr>`).join('')}
    </table></div>
    <h3>Pagamentos</h3>
    ${pgs.length ? tabelaPagamentos(pgs, false) : '<div class="vazio">Nenhum pagamento ainda.</div>'}`;
}

// ---------- mais ----------
function telaMais() {
  const c = D.config;
  return `
    <h2>Configurações</h2>
    <form data-form="config">
      <h3>Seus dados (vão no recibo)</h3>
      <div class="campos">
        <label>Seu nome<input name="credor" value="${esc(c.credor)}"></label>
        <label>Seu CPF<input name="cpfCredor" value="${esc(c.cpfCredor)}"></label>
        <label>Cidade<input name="cidade" value="${esc(c.cidade)}"></label>
        <label>Chave Pix<input name="pix" value="${esc(c.pix)}"></label>
      </div>
      <h3>Atraso (padrão para empréstimo novo)</h3>
      <div class="campos">
        <label>Multa por atraso (%)<input name="multa" inputmode="decimal" value="${c.multa}"></label>
        <label>Juros de atraso (% ao mês, por dia)<input name="mora" inputmode="decimal" value="${c.mora}"></label>
        <label>Dias de carência<input name="tolerancia" inputmode="numeric" value="${c.tolerancia}"></label>
      </div>
      <h3>Mensagens de cobrança</h3>
      <p class="fraco peq">Pode usar: {nome} {valor} {vencimento} {dias} {parcela} {parcelas} {quando} {pix}. Linha que termina vazia (ex.: Pix sem chave) sai sozinha.</p>
      <div class="campos">
        <label class="inteiro">Lembrete (antes de vencer)<textarea name="msgLembrete">${esc(c.msgLembrete)}</textarea></label>
        <label class="inteiro">Atrasado<textarea name="msgAtraso">${esc(c.msgAtraso)}</textarea></label>
      </div>
      <div class="linha-acoes"><button class="bt prim" type="submit">Salvar configurações</button></div>
    </form>

    <h3>Como funciona a cobrança</h3>
    <div class="caixa peq">
      <p>Cada empréstimo vira parcelas com vencimento. Passou do vencimento (e da carência, se tiver), a parcela leva a <b>multa</b> uma vez e os <b>juros de atraso</b> por dia, sobre o que falta pagar.</p>
      <p>Quando a pessoa paga, o valor quita primeiro a multa e os juros de atraso, depois a parcela mais antiga, e o que sobra vai para a próxima. Pagamento menor que a parcela fica como parcial e os juros continuam só sobre o que faltou.</p>
      <p>Dá para dar baixa <b>sem juros de atraso</b> (desconto) e <b>quitar tudo</b> antes: no Price, juros simples e só juros, a parcela futura paga só o capital.</p>
      <p style="margin:0">Na aba Cobrar, o botão abre o WhatsApp com a mensagem pronta. Nada é enviado sozinho.</p>
    </div>

    <h3>Trazer da planilha</h3>
    <p class="fraco peq">Copie as linhas da planilha (descrição, data, valor, situação) e cole aqui. Cada linha vira um empréstimo de parcela única com vencimento na data. Linha marcada PAGO entra já paga.</p>
    <form data-form="importar">
      <textarea name="linhas" placeholder="RAFAEL PLAY	15/11/2026	R$ 350,00	NÃO PAGO"></textarea>
      <div class="linha-acoes"><button class="bt" type="submit">Importar</button></div>
    </form>

    <h3>Cópia de segurança</h3>
    <div class="linha-acoes">
      <button class="bt" data-acao="baixarBackup">Baixar cópia (.json)</button>
      <label class="bt" style="flex-direction:row;color:var(--texto)">Restaurar cópia<input type="file" accept=".json" data-acao-arquivo="restaurar" hidden></label>
    </div>
    <p class="fraco peq">A cópia baixada não tem senha. Guarde num lugar seguro.</p>

    <h3>Aparelho</h3>
    <div class="linha-acoes"><button class="bt perigo" data-acao="sair">Sair deste aparelho</button></div>`;
}

// ---------- janelas ----------
const janela = $('#janela');
function abrirJanela(titulo, html, aoAbrir) {
  janela.innerHTML = `<div class="cab"><h2>${titulo}</h2><button class="fechar" data-acao="fecharJanela" aria-label="Fechar">×</button></div><div class="conteudo">${html}</div>`;
  if (!janela.open) janela.showModal();
  aoAbrir?.(janela);
}
const fecharJanela = () => janela.open && janela.close();

function formPessoa(id) {
  const d = (id && devedor(id)) || {};
  abrirJanela(id ? 'Editar pessoa' : 'Nova pessoa', `
    <form data-form="pessoa" data-id="${id || ''}">
      <div class="campos">
        <label class="inteiro">Nome<input name="nome" value="${esc(d.nome)}" required></label>
        <label>Apelido<input name="apelido" value="${esc(d.apelido)}"></label>
        <label>CPF<input name="cpf" value="${esc(d.cpf)}" inputmode="numeric"></label>
        <label>WhatsApp<input name="telefone" value="${esc(d.telefone)}" inputmode="tel" placeholder="(37) 99999-9999"></label>
        <label>Indicação (quem trouxe)<input name="indicacao" value="${esc(d.indicacao)}"></label>
        <label class="inteiro">Endereço<input name="endereco" value="${esc(d.endereco)}"></label>
        <label class="inteiro">Observações<textarea name="obs">${esc(d.obs)}</textarea></label>
      </div>
      <div class="rodape">
        ${id ? '<button type="button" class="bt perigo" data-acao="apagarPessoa" data-devedor="' + id + '">Apagar</button>' : ''}
        <button class="bt prim" type="submit">Salvar</button>
      </div>
    </form>`);
}

function formContrato({ devedorId, editar } = {}) {
  const c = (editar && contrato(editar)) || {};
  const cfg = D.config;
  const v = (k, padrao) => esc(c[k] ?? padrao ?? '');
  const hoje = HOJE;
  abrirJanela(editar ? 'Editar empréstimo' : 'Novo empréstimo', `
    <form data-form="contrato" data-id="${editar || ''}">
      <div class="campos">
        <label class="inteiro">Pessoa
          <select name="devedorId" required>
            <option value="">Escolha…</option>
            <option value="__nova">+ Pessoa nova</option>
            ${[...D.devedores].sort((a, b) => a.nome.localeCompare(b.nome)).map((d) => `<option value="${d.id}" ${d.id === (c.devedorId || devedorId) ? 'selected' : ''}>${esc(d.nome)}</option>`).join('')}
          </select>
        </label>
        <label class="inteiro" data-mostra="nova" hidden>Nome da pessoa nova<input name="novoNome"></label>
        <label class="inteiro">Descrição (opcional)<input name="descricao" value="${v('descricao')}" placeholder="ex.: moto, acordo, refinanciamento"></label>
        <label>Como cobra
          <select name="tipo">${Object.entries(TIPOS).map(([k, n]) => `<option value="${k}" ${k === (c.tipo || 'combinado') ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label>Data do empréstimo<input type="date" name="dataEmprestimo" value="${v('dataEmprestimo', hoje)}" required></label>
        <label>Valor emprestado (R$)<input name="valor" inputmode="decimal" value="${v('valor')}" required></label>
        <label data-tipo="combinado">Total a receber (R$)<input name="total" inputmode="decimal" value="${v('total')}"></label>
        <label data-tipo="price simples so_juros">Juros (%) <span data-rotulo-taxa>${PERIODOS[c.periodo || 'mensal'].taxa}</span><input name="taxa" inputmode="decimal" value="${v('taxa')}"></label>
        <label>Parcelas<input name="parcelas" inputmode="numeric" value="${v('parcelas', 1)}" required></label>
        <label>De quanto em quanto tempo
          <select name="periodo">${Object.entries(PERIODOS).map(([k, p]) => `<option value="${k}" ${k === (c.periodo || 'mensal') ? 'selected' : ''}>${p.nome}</option>`).join('')}</select>
        </label>
        <label>1º vencimento<input type="date" name="primeiroVenc" value="${v('primeiroVenc', somaMeses(hoje, 1))}" required></label>
        <label>Multa por atraso (%)<input name="multa" inputmode="decimal" value="${v('multa', cfg.multa)}"></label>
        <label>Juros de atraso (% ao mês)<input name="mora" inputmode="decimal" value="${v('mora', cfg.mora)}"></label>
        <label>Dias de carência<input name="tolerancia" inputmode="numeric" value="${v('tolerancia', cfg.tolerancia)}"></label>
        ${editar ? `<label>Situação<select name="status">${['ativo', 'cancelado', 'perdido'].map((s) => `<option ${s === (c.status || 'ativo') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>` : ''}
        <label class="inteiro">Observações<textarea name="obs">${v('obs')}</textarea></label>
      </div>
      <div id="previa"></div>
      <div class="rodape"><button type="button" class="bt" data-acao="fecharJanela">Cancelar</button><button class="bt prim" type="submit">Salvar</button></div>
    </form>`, (j) => {
    const f = $('form', j);
    const atualizar = () => previaContrato(f);
    f.addEventListener('input', atualizar);
    f.addEventListener('change', atualizar);
    atualizar();
  });
}

function lerContrato(f) {
  const o = formDados(f);
  return {
    ...o,
    valor: num(o.valor), total: num(o.total), taxa: num(o.taxa), parcelas: Math.max(1, Math.floor(num(o.parcelas)) || 1),
    multa: num(o.multa), mora: num(o.mora), tolerancia: Math.floor(num(o.tolerancia)),
  };
}

function previaContrato(f) {
  const c = lerContrato(f);
  $('[data-mostra="nova"]', f).hidden = c.devedorId !== '__nova';
  f.querySelectorAll('[data-tipo]').forEach((el) => { el.hidden = !el.dataset.tipo.split(' ').includes(c.tipo); });
  $('[data-rotulo-taxa]', f).textContent = PERIODOS[c.periodo].taxa;
  const alvo = $('#previa', f);
  if (!c.valor || !c.primeiroVenc || (c.tipo === 'combinado' && !c.total)) { alvo.innerHTML = ''; return; }
  const cron = gerarCronograma(c);
  const total = r2(cron.reduce((s, p) => s + p.valor, 0));
  const taxaMes = taxaMensalAprox({ ...c, cronograma: cron });
  const iguais = cron.every((p) => p.valor === cron[0].valor) || cron.slice(0, -1).every((p) => p.valor === cron[0].valor);
  alvo.innerHTML = `
    <div class="aviso verde" style="margin-top:14px">${cron.length}x de ${iguais ? brl(cron[0].valor) : 'valores diferentes'} · total ${brl(total)} · lucro ${brl(total - c.valor)}</div>
    ${taxaMes > LIMITE_USURA ? `<p class="fraco peq">Cerca de ${taxaMes.toFixed(1).replace('.', ',')}% ao mês. Acima de 1% ao mês entre pessoas físicas pode ser usura (Decreto 22.626/33).</p>` : ''}
    <div class="rolagem"><table class="tabela"><tr><th>#</th><th>Vencimento</th><th class="dir">Valor</th><th class="dir">Juros</th></tr>
    ${cron.map((p) => `<tr><td>${p.n}</td><td>${dataBR(p.venc)}</td><td class="dir">${brl(p.valor)}</td><td class="dir fraco">${brl(p.juros)}</td></tr>`).join('')}</table></div>`;
}

function formReceber({ contratoId, quitar } = {}) {
  const ativos = D.contratos.filter((c) => ativo(c) && !E.get(c.id).quitado);
  if (!ativos.length) { alert('Nenhum empréstimo em aberto.'); return; }
  abrirJanela(quitar ? 'Quitar empréstimo' : 'Registrar pagamento', `
    <form data-form="receber">
      <div class="campos">
        <label class="inteiro">Empréstimo
          <select name="contratoId" required>
            ${ativos.map((c) => `<option value="${c.id}" ${c.id === contratoId ? 'selected' : ''}>${esc(devedor(c.devedorId)?.nome)} · ${esc(c.descricao || brl(c.valor))} · falta ${brl(E.get(c.id).emAberto)}</option>`).join('')}
          </select>
        </label>
        <label>Data<input type="date" name="data" value="${HOJE}" required></label>
        <label>Valor (R$)<input name="valor" inputmode="decimal" required></label>
        <div class="inteiro atalhos" id="atalhos"></div>
        <label>Forma<select name="forma"><option>Pix</option><option>Dinheiro</option><option>Transferência</option><option>Outro</option></select></label>
        <label>Comprovante (foto)<input type="file" name="foto" accept="image/*"></label>
        <label class="marcar inteiro"><input type="checkbox" name="isentar"> Dar baixa sem multa e juros de atraso</label>
        <label class="marcar inteiro"><input type="checkbox" name="quitacao" ${quitar ? 'checked' : ''}> Quitação: o que faltar depois deste valor fica perdoado</label>
        <label class="inteiro">Observação<input name="obs"></label>
      </div>
      <div id="previa-pg" class="peq fraco" style="margin-top:10px"></div>
      <div class="rodape"><button type="button" class="bt" data-acao="fecharJanela">Cancelar</button><button class="bt prim" type="submit">Registrar</button></div>
    </form>`, (j) => {
    const f = $('form', j);
    const atalhos = () => {
      const o = formDados(f);
      const c = contrato(o.contratoId);
      const e = estadoContrato(c, D.pagamentos, o.data || HOJE);
      const prox = e.parcelas.find((p) => p.status !== 'pago');
      const vencido = r2(e.parcelas.filter((p) => p.status === 'atrasado' || p.status === 'hoje').reduce((s, p) => s + p.devido, 0));
      const opcoes = [];
      if (prox) opcoes.push([`Parcela ${prox.n}: ${brl(prox.devido)}`, prox.devido]);
      if (vencido && vencido !== prox?.devido) opcoes.push([`Tudo vencido: ${brl(vencido)}`, vencido]);
      opcoes.push([`Quitar: ${brl(e.quitarHoje)}`, e.quitarHoje, true]);
      $('#atalhos', f).innerHTML = opcoes.map(([n, v, q]) => `<button type="button" class="bt peq" data-valor="${v}" ${q ? 'data-q="1"' : ''}>${n}</button>`).join('');
      if (!f.valor.value) f.valor.value = String(quitar ? e.quitarHoje : prox?.devido || '').replace('.', ',');
    };
    $('#atalhos', f).addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-valor]');
      if (!b) return;
      f.valor.value = b.dataset.valor.replace('.', ',');
      f.quitacao.checked = !!b.dataset.q;
    });
    f.contratoId.addEventListener('change', () => { f.valor.value = ''; atalhos(); });
    f.data.addEventListener('change', atalhos);
    atalhos();
  });
}

function recibo(pagId) {
  const p = D.pagamentos.find((x) => x.id === pagId);
  const c = contrato(p.contratoId);
  const d = devedor(c.devedorId);
  const cfg = D.config;
  const ap = E.get(c.id).aplicacoes[p.id] || [];
  const ref = ap.length
    ? `pagamento ${ap.length > 1 ? 'das parcelas' : 'da parcela'} ${ap.map((a) => `${a.n}/${c.cronograma.length}`).join(', ')}`
    : 'pagamento';
  const html = `<div class="recibo">
    <h2>RECIBO</h2>
    <div class="valor-recibo">Nº ${p.recibo || '-'} · ${brl(p.valor)}</div>
    <p>Recebi de <b>${esc(d?.nome)}</b>${d?.cpf ? `, CPF ${esc(d.cpf)}` : ''}, a quantia de <b>${brl(p.valor)}</b> (${extenso(num(p.valor))}), referente ao ${ref} do valor combinado em ${dataBR(c.dataEmprestimo)}${c.descricao ? ` (${esc(c.descricao)})` : ''}${p.quitacao ? ', dando quitação total' : ''}.</p>
    ${p.forma ? `<p>Forma de pagamento: ${esc(p.forma)}.</p>` : ''}
    <p>${esc(cfg.cidade || '______________')}, ${dataBR(p.data)}.</p>
    <div class="assinatura"><div></div>${esc(cfg.credor || 'Nome de quem recebeu')}${cfg.cpfCredor ? `<br>CPF ${esc(cfg.cpfCredor)}` : ''}</div>
  </div>`;
  abrirJanela('Recibo', `${html}<div class="rodape"><button class="bt prim" data-acao="imprimir">Imprimir ou salvar PDF</button></div>`);
  $('#impressao').innerHTML = html;
}

// Reduz a foto antes de guardar (lado maior 1400 px, JPEG).
async function reduzirFoto(arquivo) {
  const img = await createImageBitmap(arquivo);
  const escala = Math.min(1, 1400 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * escala); cv.height = Math.round(img.height * escala);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.72));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- ações ----------
const acoes = {
  fecharJanela,
  tentarSalvar: () => { if (erroSalvar) { erroSalvar = false; salvarJa(); } },
  novoContrato: (ds) => formContrato({ devedorId: ds.devedor, editar: ds.editar }),
  editarPessoa: (ds) => formPessoa(ds.devedor),
  receber: (ds) => formReceber({ contratoId: ds.contrato, quitar: !!ds.quitar }),
  filtro: (ds) => { desenhar.filtro = ds.filtro; desenhar(); },
  recibo: (ds) => recibo(ds.pagamento),
  imprimir: () => print(),
  zap: (ds) => {
    const d = devedor(ds.devedor);
    const g = cobrancasPorPessoa().find((x) => x.d?.id === d.id);
    const texto = g ? mensagemCobranca(g) : `Oi ${primeiroNome(d.nome)}, tudo bem?`;
    open(linkZap(d.telefone, texto), '_blank');
    if (g) { d.ultimaCobranca = HOJE; mudou(); }
  },
  apagarPessoa: (ds) => {
    if (D.contratos.some((c) => c.devedorId === ds.devedor)) { alert('Essa pessoa tem empréstimos. Apague os empréstimos antes.'); return; }
    if (!confirm('Apagar essa pessoa?')) return;
    D.devedores = D.devedores.filter((d) => d.id !== ds.devedor);
    fecharJanela(); location.hash = '#/pessoas'; mudou();
  },
  apagarContrato: (ds) => {
    const n = D.pagamentos.filter((p) => p.contratoId === ds.contrato).length;
    if (!confirm(`Apagar este empréstimo${n ? ` e os ${n} pagamentos dele` : ''}? Para guardar o histórico, prefira Editar > Situação: cancelado.`)) return;
    const c = contrato(ds.contrato);
    D.contratos = D.contratos.filter((x) => x.id !== ds.contrato);
    D.pagamentos = D.pagamentos.filter((p) => p.contratoId !== ds.contrato);
    location.hash = `#/pessoa/${c.devedorId}`; mudou();
  },
  apagarPagamento: (ds) => {
    if (!confirm('Apagar este pagamento?')) return;
    D.pagamentos = D.pagamentos.filter((p) => p.id !== ds.pagamento);
    mudou();
  },
  verComprovante: async (ds) => {
    abrirJanela('Comprovante', '<p class="fraco">Abrindo…</p>');
    try {
      const bytes = await guarda.lerArquivo(ds.pagamento);
      if (!bytes) throw new Error('arquivo não encontrado');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      $('.conteudo', janela).innerHTML = `<img class="foto-comprovante" src="${url}" alt="Comprovante">`;
    } catch (e) { $('.conteudo', janela).innerHTML = `<p>Não abriu: ${esc(e.message)}</p>`; }
  },
  baixarBackup: () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(D, null, 2)], { type: 'application/json' }));
    a.download = `dinheiro-na-rua-${HOJE}.json`;
    a.click();
  },
  sair: () => {
    if (!confirm('Sair deste aparelho? Vai pedir a senha de novo.')) return;
    localStorage.removeItem('dnr-chave');
    location.reload();
  },
};

const formularios = {
  pessoa: (f) => {
    const o = formDados(f);
    if (f.dataset.id) Object.assign(devedor(f.dataset.id), o);
    else { const d = { id: uid(), criado: Date.now(), ...o }; D.devedores.push(d); location.hash = `#/pessoa/${d.id}`; }
    fecharJanela(); mudou();
  },
  contrato: (f) => {
    const o = lerContrato(f);
    if (o.devedorId === '__nova') {
      if (!o.novoNome) { alert('Escreva o nome da pessoa nova.'); return; }
      const d = { id: uid(), criado: Date.now(), nome: o.novoNome };
      D.devedores.push(d); o.devedorId = d.id;
    }
    if (o.tipo === 'combinado' && !o.total) { alert('Falta o total a receber.'); return; }
    delete o.novoNome;
    if (o.tipo !== 'combinado') delete o.total; else o.taxa = 0;
    o.cronograma = gerarCronograma(o);
    if (f.dataset.id) {
      const c = contrato(f.dataset.id);
      const temPagamento = D.pagamentos.some((p) => p.contratoId === c.id);
      const mudouConta = ['tipo', 'valor', 'total', 'taxa', 'parcelas', 'periodo', 'primeiroVenc'].some((k) => String(c[k] ?? '') !== String(o[k] ?? ''));
      if (temPagamento && mudouConta && !confirm('As parcelas vão ser refeitas e os pagamentos já feitos são aplicados de novo nelas. Continuar?')) return;
      Object.assign(c, o);
    } else {
      const c = { id: uid(), criado: Date.now(), status: 'ativo', ...o };
      D.contratos.push(c);
      location.hash = `#/contrato/${c.id}`;
    }
    fecharJanela(); mudou();
  },
  receber: async (f) => {
    const o = formDados(f);
    const valor = num(o.valor);
    if (!(valor > 0)) { alert('Valor inválido.'); return; }
    const botao = $('button[type=submit]', f);
    botao.disabled = true;
    const p = {
      id: uid(), criado: Date.now(), contratoId: o.contratoId, data: o.data, valor, forma: o.forma, obs: o.obs,
      isentar: o.isentar, quitacao: o.quitacao, recibo: ++D.config.reciboN,
    };
    const arq = f.foto.files[0];
    if (arq) {
      try { botao.textContent = 'Enviando foto…'; await guarda.salvarArquivo(p.id, await reduzirFoto(arq)); p.comprovante = true; }
      catch (e) { if (!confirm(`A foto não subiu (${e.message}). Registrar sem foto?`)) { botao.disabled = false; botao.textContent = 'Registrar'; return; } }
    }
    D.pagamentos.push(p);
    mudou();
    recibo(p.id);
  },
  config: (f) => {
    const o = formDados(f);
    Object.assign(D.config, o, { multa: num(o.multa), mora: num(o.mora), tolerancia: Math.floor(num(o.tolerancia)) });
    mudou();
    alert('Configurações salvas.');
  },
  importar: (f) => {
    const linhas = f.linhas.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let n = 0;
    const erros = [];
    for (const l of linhas) {
      const partes = l.split(/\t|;/).map((x) => x.trim());
      const [nome, data, valorTxt, situacao = ''] = partes;
      const m = (data || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      const valor = num(valorTxt);
      if (!nome || !m || !valor) { erros.push(l); continue; }
      const ano = m[3].length === 2 ? '20' + m[3] : m[3];
      const venc = `${ano}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      let d = D.devedores.find((x) => x.nome.toLowerCase() === nome.toLowerCase());
      if (!d) { d = { id: uid(), criado: Date.now(), nome }; D.devedores.push(d); }
      const c = {
        id: uid(), criado: Date.now(), status: 'ativo', devedorId: d.id, descricao: 'da planilha', tipo: 'combinado',
        dataEmprestimo: venc, valor, total: valor, taxa: 0, parcelas: 1, periodo: 'mensal', primeiroVenc: venc,
        multa: D.config.multa, mora: D.config.mora, tolerancia: D.config.tolerancia,
        obs: 'Importado da planilha. Valor emprestado não informado (ficou igual ao valor a receber).',
      };
      c.cronograma = gerarCronograma(c);
      D.contratos.push(c);
      if (/^pago/i.test(situacao)) D.pagamentos.push({ id: uid(), criado: Date.now(), contratoId: c.id, data: venc, valor, forma: 'Outro', obs: 'pago (planilha)', recibo: ++D.config.reciboN });
      n++;
    }
    mudou();
    alert(`${n} importados.${erros.length ? `\nNão entenderam ${erros.length} linhas:\n${erros.slice(0, 5).join('\n')}` : ''}`);
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-acao]');
  if (!el || !acoes[el.dataset.acao]) return;
  ev.preventDefault();
  acoes[el.dataset.acao](el.dataset);
});
document.addEventListener('submit', (ev) => {
  const f = ev.target.closest('[data-form]');
  if (!f || !formularios[f.dataset.form]) return;
  ev.preventDefault();
  formularios[f.dataset.form](f);
});
document.addEventListener('input', (ev) => { if (ev.target.dataset.acaoInput === 'busca') filtrarBusca(); });
document.addEventListener('change', async (ev) => {
  if (ev.target.dataset.acaoArquivo !== 'restaurar') return;
  const arq = ev.target.files[0];
  if (!arq) return;
  try {
    const novo = JSON.parse(await arq.text());
    if (!Array.isArray(novo.contratos) || !Array.isArray(novo.devedores)) throw new Error('arquivo não é uma cópia do Dinheiro na Rua');
    if (!confirm(`Trocar tudo pelos dados da cópia (${novo.devedores.length} pessoas, ${novo.contratos.length} empréstimos)?`)) return;
    D = novo; mudou();
  } catch (e) { alert(`Não restaurou: ${e.message}`); }
});
// Recalcula na virada do dia se o app ficar aberto.
setInterval(() => { if (D && hojeISO() !== HOJE) { calcular(); desenhar(); } }, 60000);

iniciar();
