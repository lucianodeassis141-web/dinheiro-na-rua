// Cálculo de empréstimos: cronograma, pagamentos, multa e juros de atraso.
// Sem DOM: roda no navegador e no Node (testes em testes/calc.test.js).

export const TIPOS = {
  combinado: 'Valor combinado',
  price: 'Parcela fixa (Price)',
  simples: 'Juros simples',
  so_juros: 'Só juros, capital no fim',
};

export const PERIODOS = {
  mensal: { nome: 'Mensal', taxa: 'ao mês', dias: 30 },
  quinzenal: { nome: 'Quinzenal', taxa: 'por quinzena', dias: 15 },
  semanal: { nome: 'Semanal', taxa: 'por semana', dias: 7 },
  diario: { nome: 'Diário', taxa: 'ao dia', dias: 1 },
};

export const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const ZERO = 0.009;

// Datas sempre como 'AAAA-MM-DD'.
const DIA = 86400000;
export function diaN(s) {
  const [a, m, d] = s.split('-').map(Number);
  return Date.UTC(a, m - 1, d) / DIA;
}
export function nDia(n) {
  return new Date(n * DIA).toISOString().slice(0, 10);
}
export const difDias = (a, b) => diaN(a) - diaN(b);
export const somaDias = (s, n) => nDia(diaN(s) + n);
export function somaMeses(s, n) {
  const [a, m, d] = s.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}
export function hojeISO(agora = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}`;
}
export function vencimentoN(primeiro, periodo, k) {
  if (periodo === 'mensal') return somaMeses(primeiro, k);
  return somaDias(primeiro, k * PERIODOS[periodo].dias);
}

// Distribui `total` em n partes iguais; a última leva a sobra do arredondamento.
function partes(total, n) {
  const base = r2(total / n);
  return Array.from({ length: n }, (_, k) => (k === n - 1 ? r2(total - base * (n - 1)) : base));
}

// c: { tipo, valor, total, taxa, parcelas, periodo, primeiroVenc }
export function gerarCronograma(c) {
  const n = Math.max(1, Math.floor(c.parcelas || 1));
  const PV = Number(c.valor) || 0;
  const i = (Number(c.taxa) || 0) / 100;
  const amorts = partes(PV, n);
  const linhas = [];
  if (c.tipo === 'price') {
    const pmt = i === 0 ? r2(PV / n) : r2((PV * i) / (1 - (1 + i) ** -n));
    let saldo = PV;
    for (let k = 0; k < n; k++) {
      const juros = r2(saldo * i);
      const ultima = k === n - 1;
      const amort = ultima ? r2(saldo) : r2(pmt - juros);
      saldo = r2(saldo - amort);
      linhas.push({ amort, juros, valor: ultima ? r2(amort + juros) : pmt });
    }
  } else if (c.tipo === 'simples') {
    const juros = r2(PV * i);
    for (let k = 0; k < n; k++) linhas.push({ amort: amorts[k], juros, valor: r2(amorts[k] + juros) });
  } else if (c.tipo === 'so_juros') {
    const juros = r2(PV * i);
    for (let k = 0; k < n; k++) {
      const amort = k === n - 1 ? PV : 0;
      linhas.push({ amort, juros, valor: r2(amort + juros) });
    }
  } else {
    // combinado: emprestou `valor`, recebe `total` dividido em n
    const T = Number(c.total) || PV;
    const vals = partes(T, n);
    for (let k = 0; k < n; k++) linhas.push({ amort: amorts[k], juros: r2(vals[k] - amorts[k]), valor: vals[k] });
  }
  return linhas.map((l, k) => ({ n: k + 1, venc: vencimentoN(c.primeiroVenc, c.periodo || 'mensal', k), ...l }));
}

// Taxa ao mês equivalente, para o aviso da Lei da Usura. Juros simples sobre o prazo.
export function taxaMensalAprox(c) {
  const PV = Number(c.valor) || 0;
  if (!PV) return 0;
  if (c.tipo !== 'combinado') return (Number(c.taxa) || 0) * 30 / PERIODOS[c.periodo || 'mensal'].dias;
  const cron = c.cronograma || gerarCronograma(c);
  const total = cron.reduce((s, p) => s + p.valor, 0);
  const inicio = c.dataEmprestimo || c.primeiroVenc;
  const ultimo = cron[cron.length - 1].venc;
  const meses = Math.max(difDias(ultimo, inicio), 1) / 30;
  return ((total / PV - 1) / meses) * 100;
}

// Lança os encargos de atraso de uma parcela até a data `ate`.
// Multa uma vez sobre o que estava em aberto; juros de mora pro rata dia.
function acumular(p, ate, regras) {
  if (p.saldo <= ZERO) return;
  const atraso = difDias(ate, p.venc);
  if (atraso <= (regras.tolerancia || 0)) return;
  if (!p.multaLancada) {
    p.encargo = r2(p.encargo + p.saldo * (regras.multa || 0) / 100);
    p.multaLancada = true;
  }
  const desde = diaN(p.ultimaMora) > diaN(p.venc) ? p.ultimaMora : p.venc;
  const dias = difDias(ate, desde);
  if (dias > 0) {
    p.encargo = r2(p.encargo + (p.saldo * (regras.mora || 0) / 100 / 30) * dias);
    p.ultimaMora = ate;
  }
}

const aberta = (p) => p.saldo > ZERO || p.encargo > ZERO;

// Estado do contrato em `hoje`, aplicando os pagamentos em ordem de data.
// Cada pagamento quita primeiro multa e juros de atraso, depois a parcela, da mais antiga para a mais nova.
export function estadoContrato(c, pagamentos, hoje) {
  const regras = { multa: c.multa, mora: c.mora, tolerancia: c.tolerancia };
  const ps = (c.cronograma || gerarCronograma(c)).map((p) => ({
    ...p, saldo: p.valor, encargo: 0, encargoPago: 0, multaLancada: false, ultimaMora: p.venc, pagoEm: null,
  }));
  const meus = pagamentos
    .filter((x) => x.contratoId === c.id)
    .sort((a, b) => difDias(a.data, b.data) || (a.criado || 0) - (b.criado || 0));
  let recebido = 0, encargosRecebidos = 0, desconto = 0, excedente = 0;
  const aplicacoes = {};

  for (const pg of meus) {
    let resto = Number(pg.valor) || 0;
    recebido = r2(recebido + resto);
    const ap = [];
    for (const p of ps) acumular(p, pg.data, regras);
    if (pg.isentar) for (const p of ps) { desconto = r2(desconto + p.encargo); p.encargo = 0; }
    for (const p of ps) {
      if (resto <= ZERO) break;
      if (!aberta(p)) continue;
      const e = Math.min(resto, p.encargo);
      p.encargo = r2(p.encargo - e); p.encargoPago = r2(p.encargoPago + e);
      encargosRecebidos = r2(encargosRecebidos + e); resto = r2(resto - e);
      const s = Math.min(resto, p.saldo);
      p.saldo = r2(p.saldo - s); resto = r2(resto - s);
      if (e + s > 0) ap.push({ n: p.n, valor: r2(e + s), encargo: r2(e) });
      if (!aberta(p)) p.pagoEm = pg.data;
    }
    if (pg.quitacao) {
      for (const p of ps) {
        if (!aberta(p)) continue;
        desconto = r2(desconto + p.saldo + p.encargo);
        p.saldo = 0; p.encargo = 0; p.pagoEm = pg.data;
      }
    }
    excedente = r2(excedente + Math.max(resto, 0));
    aplicacoes[pg.id] = ap;
  }

  for (const p of ps) acumular(p, hoje, regras);

  let emAberto = 0, atrasado = 0, quitarHoje = 0, qtdAtrasadas = 0, proxima = null;
  for (const p of ps) {
    const d = difDias(hoje, p.venc);
    p.diasAtraso = Math.max(d, 0);
    if (!aberta(p)) { p.status = 'pago'; continue; }
    const devido = r2(p.saldo + p.encargo);
    p.devido = devido;
    emAberto = r2(emAberto + devido);
    if (d > 0) { p.status = 'atrasado'; atrasado = r2(atrasado + devido); qtdAtrasadas++; }
    else if (d === 0) p.status = 'hoje';
    else p.status = p.saldo < p.valor - ZERO ? 'parcial' : 'aberto';
    if (!proxima) proxima = p;
    // Quitação antecipada: parcela futura paga só o capital que falta dela (exceto valor combinado).
    if (d < 0 && c.tipo !== 'combinado' && p.valor > 0) quitarHoje = r2(quitarHoje + p.saldo * (p.amort / p.valor));
    else quitarHoje = r2(quitarHoje + devido);
  }

  const PV = Number(c.valor) || 0;
  const totalContratado = r2(ps.reduce((s, p) => s + p.valor, 0));
  const quitado = ps.every((p) => !aberta(p));
  return {
    parcelas: ps,
    recebido, encargosRecebidos, desconto, excedente,
    emAberto, atrasado, qtdAtrasadas, quitarHoje, proxima, quitado,
    totalContratado,
    capitalVoltou: r2(Math.min(recebido, PV)),
    naRua: r2(Math.max(PV - recebido, 0)),
    lucro: r2(Math.max(recebido - PV, 0)),
    lucroPrevisto: r2(totalContratado - PV),
    aplicacoes,
    situacao: c.status === 'cancelado' || c.status === 'perdido' ? c.status : quitado ? 'quitado' : qtdAtrasadas ? 'atrasado' : 'em dia',
  };
}

// Valor por extenso, para o recibo.
const UN = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CT = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
function ate999(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100), r = n % 100, partes = [];
  if (c) partes.push(CT[c]);
  if (r < 20) { if (r) partes.push(UN[r]); }
  else { partes.push(DZ[Math.floor(r / 10)]); if (r % 10) partes.push(UN[r % 10]); }
  return partes.join(' e ');
}
function inteiroExtenso(n) {
  if (n === 0) return 'zero';
  const grupos = [];
  const nomes = [['', ''], ['mil', 'mil'], ['milhão', 'milhões'], ['bilhão', 'bilhões']];
  let k = 0;
  while (n > 0) {
    const g = n % 1000;
    if (g) {
      let t = k === 1 && g === 1 ? 'mil' : ate999(g) + (k ? ' ' + nomes[k][g === 1 ? 0 : 1] : '');
      grupos.unshift({ t, g });
    }
    n = Math.floor(n / 1000); k++;
  }
  return grupos.map((x, idx) => {
    if (idx === 0) return x.t;
    return (x.g < 100 || x.g % 100 === 0 ? ' e ' : ' ') + x.t;
  }).join('');
}
export function extenso(valor) {
  const cent = Math.round(valor * 100);
  const reais = Math.floor(cent / 100), cts = cent % 100;
  const partes = [];
  if (reais) {
    const milhoes = reais >= 1e6 && reais % 1e6 === 0;
    partes.push(inteiroExtenso(reais) + (milhoes ? ' de' : '') + (reais === 1 ? ' real' : ' reais'));
  }
  if (cts) partes.push(inteiroExtenso(cts) + (cts === 1 ? ' centavo' : ' centavos'));
  return partes.length ? partes.join(' e ') : 'zero reais';
}
