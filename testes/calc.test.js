// node --test testes/
import test from 'node:test';
import assert from 'node:assert/strict';
import { gerarCronograma, estadoContrato, extenso, somaMeses, taxaMensalAprox } from '../js/calc.js';

const base = { id: 'c1', valor: 1000, taxa: 10, parcelas: 3, periodo: 'mensal', primeiroVenc: '2026-01-31', dataEmprestimo: '2026-01-01', multa: 2, mora: 30, tolerancia: 0 };
const soma = (cron) => Math.round(cron.reduce((s, p) => s + p.valor, 0) * 100) / 100;

test('meses no fim do mês', () => {
  assert.equal(somaMeses('2026-01-31', 1), '2026-02-28');
  assert.equal(somaMeses('2026-01-31', 2), '2026-03-31');
});

test('Price: parcela fixa e capital fecha', () => {
  const cron = gerarCronograma({ ...base, tipo: 'price' });
  assert.equal(cron[0].valor, 402.11);
  assert.equal(cron[1].valor, 402.11);
  assert.equal(Math.round(cron.reduce((s, p) => s + p.amort, 0) * 100) / 100, 1000);
  assert.equal(cron[0].juros, 100);
});

test('simples, só juros e combinado', () => {
  assert.equal(soma(gerarCronograma({ ...base, tipo: 'simples' })), 1300);
  const sj = gerarCronograma({ ...base, tipo: 'so_juros' });
  assert.deepEqual(sj.map((p) => p.valor), [100, 100, 1100]);
  const cb = gerarCronograma({ ...base, tipo: 'combinado', total: 1300, parcelas: 3 });
  assert.deepEqual(cb.map((p) => p.valor), [433.33, 433.33, 433.34]);
});

test('pagamento em dia, parcial e atraso com multa e mora', () => {
  const c = { ...base, tipo: 'combinado', total: 1200, parcelas: 2, primeiroVenc: '2026-02-01' };
  // parcela 1 = 600 em 01/02, parcela 2 = 600 em 01/03
  let e = estadoContrato(c, [], '2026-02-01');
  assert.equal(e.parcelas[0].status, 'hoje');
  assert.equal(e.emAberto, 1200);

  // 11 dias de atraso: multa 2% de 600 = 12, mora 30% a.m. = 1%/dia = 6/dia * 11 = 66
  e = estadoContrato(c, [], '2026-02-12');
  assert.equal(e.parcelas[0].status, 'atrasado');
  assert.equal(e.parcelas[0].devido, 678);

  // paga 300 no dia 12: vai 78 para encargos e 222 para a parcela
  const pgs = [{ id: 'p1', contratoId: 'c1', data: '2026-02-12', valor: 300 }];
  e = estadoContrato(c, pgs, '2026-02-12');
  assert.equal(e.encargosRecebidos, 78);
  assert.equal(e.parcelas[0].saldo, 378);
  assert.equal(e.parcelas[0].devido, 378);

  // mora continua só sobre o que ficou (378 * 1% * 2 dias)
  e = estadoContrato(c, pgs, '2026-02-14');
  assert.equal(e.parcelas[0].devido, 385.56);
});

test('isentar juros e quitação antecipada', () => {
  const c = { ...base, tipo: 'combinado', total: 1200, parcelas: 2, primeiroVenc: '2026-02-01' };
  let e = estadoContrato(c, [{ id: 'p', contratoId: 'c1', data: '2026-02-12', valor: 600, isentar: true }], '2026-02-12');
  assert.equal(e.parcelas[0].status, 'pago');
  assert.equal(e.desconto, 78);

  const p = { ...base, tipo: 'price' };
  e = estadoContrato(p, [], '2026-01-10');
  assert.equal(e.quitarHoje, 1000); // tudo futuro: só o capital
  e = estadoContrato(p, [{ id: 'q', contratoId: 'c1', data: '2026-01-10', valor: 1000, quitacao: true }], '2026-01-10');
  assert.equal(e.quitado, true);
  assert.equal(e.situacao, 'quitado');
});

test('tolerância segura multa e mora', () => {
  const c = { ...base, tipo: 'combinado', total: 500, parcelas: 1, primeiroVenc: '2026-02-01', tolerancia: 3 };
  assert.equal(estadoContrato(c, [], '2026-02-04').parcelas[0].devido, 500);
  assert.equal(estadoContrato(c, [], '2026-02-05').parcelas[0].devido, 530); // multa 10 + 4 dias de 5
});

test('lucro só depois do capital voltar', () => {
  const c = { ...base, tipo: 'combinado', total: 1300, parcelas: 1, primeiroVenc: '2026-02-01' };
  assert.equal(estadoContrato(c, [{ id: 'a', contratoId: 'c1', data: '2026-01-20', valor: 800 }], '2026-01-20').lucro, 0);
  const e = estadoContrato(c, [{ id: 'a', contratoId: 'c1', data: '2026-01-20', valor: 1300 }], '2026-01-20');
  assert.equal(e.lucro, 300);
  assert.equal(e.naRua, 0);
});

test('taxa mensal aproximada', () => {
  const c = { ...base, tipo: 'combinado', total: 1300, parcelas: 1, primeiroVenc: '2026-01-31' };
  assert.equal(Math.round(taxaMensalAprox(c)), 30);
});

test('extenso', () => {
  assert.equal(extenso(1), 'um real');
  assert.equal(extenso(1440), 'mil quatrocentos e quarenta reais');
  assert.equal(extenso(350.5), 'trezentos e cinquenta reais e cinquenta centavos');
  assert.equal(extenso(2100000), 'dois milhões e cem mil reais');
  assert.equal(extenso(1525), 'mil quinhentos e vinte e cinco reais');
});
