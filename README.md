# Dinheiro na Rua

Controle de empréstimos e recebimentos: pessoas, empréstimos com juros, parcelas, pagamentos,
multa e juros de atraso, cobrança pelo WhatsApp, recibo e comprovante.

- Site estático (HTML, CSS e JS puro), publicado pelo GitHub Pages.
- Os dados ficam num repositório **privado** separado, no arquivo `dados.enc`, criptografados
  com AES-GCM. A chave sai da senha (PBKDF2, 600 mil voltas). Sem a senha ninguém lê.
- `config.json` guarda só o token do GitHub cifrado com a mesma senha e o nome do repositório dos dados.

## Tipos de empréstimo

| Tipo | Como funciona |
|---|---|
| Valor combinado | Emprestou X, recebe Y dividido em N parcelas |
| Parcela fixa (Price) | Juros compostos, todas as parcelas iguais |
| Juros simples | Juros sobre o valor emprestado, igual em toda parcela |
| Só juros | Paga só os juros em cada parcela e o capital na última |

Períodos: mensal, quinzenal, semanal e diário.

## Atraso

Depois do vencimento (e da carência), a parcela leva a multa uma vez e os juros de atraso por dia
(% ao mês dividido por 30) sobre o que falta. O pagamento quita primeiro multa e juros de atraso,
depois a parcela mais antiga.

## Testar no PC

`node ../servidor.mjs` e abrir http://localhost:5260/?teste (dados só no navegador, qualquer senha).

`npm test` roda os testes do cálculo.

## Primeira configuração

1. Criar um token fine-grained no GitHub só para o repositório dos dados, com Contents: leitura e escrita.
2. Abrir o site sem `config.json`, preencher repositório, token e senha.
3. Subir o `config.json` gerado na raiz deste repositório.
