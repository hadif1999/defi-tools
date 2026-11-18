import { h, icon, clear } from '../dom.js';
import { api } from '../api.js';
import { usd, num, short, time } from '../format.js';
import { card, cliHint, field, input, select, segmented, badge, errorBox, notesBanner, copyButton } from '../ui.js';
import { formValues, rememberForm } from '../state.js';

// Plan a new Uniswap v3 position (positions create): range, amounts, volatility check, simulation, and the approve and
// mint transactions to sign in order. Nothing is signed or sent: the dashboard is as read-only as the CLI.

export async function render(root, ctx) {
  const evm = ctx.wallets().filter((wallet) => wallet.type === 'evm');
  const defaults = { pair: 'WETH/USDC', pool: '', chain: 'base', wallet: '', amount: '100usd', lowerLimit: '-15%', upperLimit: '+10%', fullRange: false, fee: '', slippage: '0.5', deadline: '20m', payWith: 'auto', approve: 'exact', signer: 'mm' };
  const values = { ...formValues('plan', defaults), ...Object.fromEntries(Object.entries(ctx.params).filter(([key]) => key in defaults)) };
  if (ctx.params.pool) values.pair = '';
  if (ctx.params.pair) values.pool = '';
  const pair = input({ value: values.pair, placeholder: 'WETH/USDC', name: 'pair' });
  const pool = input({ value: values.pool, placeholder: '0x pool address (instead of a pair)', name: 'pool' });
  const chain = select(ctx.meta.createChains.map((slug) => [slug, ctx.meta.chains.find((item) => item.slug === slug)?.name ?? slug]), { value: values.chain, name: 'chain' });
  const wallet = select([['', `Default wallet${ctx.meta.defaultWallet ? ` (${ctx.meta.defaultWallet.name})` : ''}`], ...evm.map((item) => [item.name, `${item.name} · ${short(item.address)}`])], { value: values.wallet, name: 'wallet' });
  const amount = input({ value: values.amount, placeholder: '100usd, 0.05weth or max', name: 'amount' });
  const lower = input({ value: values.lowerLimit, placeholder: '-15% or 2100', name: 'lowerLimit' });
  const upper = input({ value: values.upperLimit, placeholder: '+10% or 2700', name: 'upperLimit' });
  const fullRange = h('input', { type: 'checkbox', checked: values.fullRange, onchange: () => { lower.disabled = upper.disabled = fullRange.checked; } });
  lower.disabled = upper.disabled = values.fullRange;
  const fee = select([['', 'Deepest pool'], ['0.01', '0.01%'], ['0.05', '0.05%'], ['0.3', '0.3%'], ['1', '1%']], { value: values.fee, name: 'fee' });
  const slippage = input({ value: values.slippage, name: 'slippage' });
  const deadline = input({ value: values.deadline, name: 'deadline' });
  const payWith = select([['auto', 'WETH, or ETH when short'], ['weth', 'WETH'], ['eth', 'Native ETH']], { value: values.payWith, name: 'payWith' });
  const approve = select([['exact', 'Exactly what is needed'], ['unlimited', 'Unlimited']], { value: values.approve, name: 'approve' });
  let signer = values.signer;
  const fields = {
    pair: field('Pair', pair, { hint: 'Symbols or token addresses' }), pool: field('…or pool', pool), chain: field('Network', chain), wallet: field('Wallet that signs', wallet, { hint: 'Pays the tokens and receives the NFT' }),
    amount: field('Amount', amount, { hint: 'USD total, one token amount, or max' }), lower: field('Lower limit', lower, { hint: '% from the price, or a price' }), upper: field('Upper limit', upper),
    fee: field('Fee tier', fee), slippage: field('Slippage %', slippage), deadline: field('Deadline', deadline, { hint: '20m, 1h' }), payWith: field('Pay with', payWith), approve: field('Approve', approve),
  };
  const output = h('div');
  const hint = h('div');
  const submit = h('button', { class: 'btn primary', type: 'submit' }, icon('play'), 'Build plan');
  const form = h('form', { class: 'card', onsubmit: (event) => { event.preventDefault(); void build(); } },
    h('header', null, h('h2', null, 'New Uniswap v3 position'), badge('Base and Arbitrum', 'accent'), h('span', { class: 'grow' }), submit),
    h('div', { class: 'body', style: { display: 'grid', gap: '14px' } },
      h('div', { class: 'form-grid' }, Object.values(fields)),
      h('div', { class: 'toolbar' }, h('label', { class: 'check' }, fullRange, 'Full range (every price)'), h('span', { class: 'grow' }), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Transactions as'),
        segmented([['mm', 'mm commands'], ['raw', 'Raw to / value / data']], signer, (next) => { signer = next; if (last) draw(last); }, { label: 'Signer' }))));
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Plan a position'), h('p', null, 'Reads the pool and your wallet on-chain, simulates the mint, and builds the transactions. Nothing is signed or sent.'))),
    h('div', { class: 'note info' }, icon('lock'), h('div', null, h('b', null, 'Read-only. '), 'The dashboard never asks for a private key. Sign the steps below with your own wallet, in order.')), form, output, hint);

  const request = () => ({
    pair: pair.value.trim() || undefined, pool: pool.value.trim() || undefined, chain: chain.value, wallet: wallet.value || undefined, amount: amount.value.trim(),
    lowerLimit: fullRange.checked ? undefined : lower.value.trim() || undefined, upperLimit: fullRange.checked ? undefined : upper.value.trim() || undefined, fullRange: fullRange.checked || undefined,
    fee: fee.value || undefined, slippage: slippage.value.trim() || '0.5', deadline: deadline.value.trim() || '20m', payWith: payWith.value, approve: approve.value,
  });
  const cli = (body) => ['defi-tool positions create', body.pair ?? `--pool ${body.pool}`, `--chain ${body.chain}`, body.wallet && `--wallet ${body.wallet}`, `--amount ${body.amount}`,
    body.fullRange ? '--full-range' : `--lower-limit ${body.lowerLimit} --upper-limit ${body.upperLimit}`, body.fee && `--fee ${body.fee}`, body.slippage !== '0.5' && `--slippage ${body.slippage}`,
    body.deadline !== '20m' && `--deadline ${body.deadline}`, body.payWith !== 'auto' && `--pay-with ${body.payWith}`, body.approve !== 'exact' && `--approve ${body.approve}`, signer !== 'mm' && `--signer ${signer}`].filter(Boolean).join(' ');

  let last;
  let controller;
  async function build() {
    const body = request();
    Object.values(fields).forEach((item) => item.setError());
    if (!body.pair && !body.pool) { fields.pair.setError('Give a pair such as WETH/USDC, or a pool address.'); return; }
    if (body.pair && body.pool) { fields.pool.setError('Give a pair or a pool, not both.'); return; }
    if (!body.amount) { fields.amount.setError('Amount is required.'); return; }
    rememberForm('plan', { ...body, pair: body.pair ?? '', pool: body.pool ?? '', fullRange: Boolean(body.fullRange), fee: body.fee ?? '', wallet: body.wallet ?? '', lowerLimit: lower.value, upperLimit: upper.value, signer });
    clear(hint).append(cliHint(cli(body)));
    controller?.abort();
    controller = new AbortController();
    submit.disabled = true;
    clear(output).append(card('Building the plan', h('div', { style: { display: 'grid', gap: '10px' } }, h('div', { class: 'progress' }, h('div')), h('span', { class: 'muted' }, 'Reading the pool, balances and allowances, checking volatility, simulating the mint…'))));
    try {
      last = await api.post('/api/positions/plan', body, { signal: controller.signal });
      draw(last);
    } catch (error) {
      if (error.name === 'AbortError') return;
      const message = error.message;
      const target = /--amount/.test(message) ? fields.amount : /--lower-limit/.test(message) ? fields.lower : /--upper-limit/.test(message) ? fields.upper : /--fee/.test(message) ? fields.fee : /--slippage/.test(message) ? fields.slippage : /--deadline/.test(message) ? fields.deadline : /--wallet|wallet/i.test(message) ? fields.wallet : /--pool/.test(message) ? fields.pool : undefined;
      target?.setError(message);
      clear(output).append(errorBox(error, () => build()));
    } finally { submit.disabled = false; }
  }

  function draw(result) {
    const plan = result.data;
    const { token0, token1, range, deposit } = plan;
    const amountText = (value, symbol) => `${num(Number(value))} ${symbol}`;
    const sides = [[deposit.amount0, token0, 0], [deposit.amount1, token1, 1]].filter(([value]) => Number(value) > 0)
      .map(([value, info, side]) => `${amountText(value, deposit.nativeSide === side ? 'ETH' : info.symbol)}${info.priceUsd !== undefined ? ` (${usd(Number(value) * info.priceUsd)})` : ''}`);
    const sim = plan.simulation;
    const simBadge = sim.status === 'passed' ? badge(`Simulation passed${sim.tokenId ? ` · would mint #${sim.tokenId}` : ''}${sim.gas ? ` · ~${Number(sim.gas).toLocaleString('en-US')} gas` : ''}`, 'up')
      : sim.status === 'failed' ? badge(`Simulation failed: ${sim.message}`, 'down') : badge('Simulated after the approvals', 'warn');
    const days = (value) => value === undefined ? undefined : value < 1 ? '<1 day' : `~${Math.round(value)} days`;
    const rows = [
      ['Pool', `${token0.symbol}/${token1.symbol} ${plan.pool.feeTier / 10_000}% v3 · ${short(plan.pool.address)}${plan.pool.tvlUsd !== undefined ? ` · TVL ${usd(plan.pool.tvlUsd)}` : ''}`],
      ['Price now', `${num(plan.price)} ${plan.unit}`],
      ['Range', range.fullRange ? 'Full range (every price)' : `${num(range.lower)} – ${num(range.upper)} ${plan.unit} (${range.lowerPct >= 0 ? '+' : ''}${range.lowerPct.toFixed(1)}% / ${range.upperPct >= 0 ? '+' : ''}${range.upperPct.toFixed(1)}%)`],
      ['Ticks', `${range.tickLower} to ${range.tickUpper} · spacing ${plan.pool.tickSpacing}${range.inRange ? '' : ' · starts out of range'}`],
      ['Deposit', `${sides.join(' + ') || '0'}${deposit.valueUsd !== undefined ? ` = ${usd(deposit.valueUsd)}` : ''}`],
      ['Minimum', `${amountText(deposit.min0, token0.symbol)}, ${amountText(deposit.min1, token1.symbol)}`],
      ['Wallet', `${short(plan.wallet)}: ${amountText(plan.wallets.balance0, token0.symbol)}, ${amountText(plan.wallets.balance1, token1.symbol)}, ${amountText(plan.wallets.native, 'ETH')}`],
      plan.volatility && ['Volatility', `±${plan.volatility.dailyPct.toFixed(1)}% a day over ${plan.volatility.days} days${[days(plan.volatility.daysToLower) && `lower limit ${days(plan.volatility.daysToLower)}`, days(plan.volatility.daysToUpper) && `upper limit ${days(plan.volatility.daysToUpper)}`].filter(Boolean).map((text, index) => `${index ? ', ' : '; a typical move reaches the '}${text}`).join('')}`],
      ['Deadline', `${time(plan.deadline)} UTC`],
    ].filter(Boolean);
    const others = plan.pool.others?.length ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, `Other tiers: ${plan.pool.others.map((other) => `${other.feeTier / 10_000}% (${usd(other.tvlUsd)})`).join(', ')}`) : null;
    clear(output).append(
      notesBanner(result.notes, { kind: 'info' }) ?? '',
      h('div', { class: 'grid two' },
        card('Plan', h('div', { style: { display: 'grid', gap: '12px' } }, h('div', { class: 'split' }, simBadge, plan.ready ? badge('Ready to sign', 'up') : badge('Not ready', 'down')), h('dl', { class: 'kv' }, rows.flatMap(([label, value]) => [h('dt', null, label), h('dd', null, value)])), others),
          { sub: ctx.meta.chains.find((item) => item.id === plan.chainId)?.name }),
        card('Warnings', plan.warnings.length ? h('div', { class: 'notes' }, plan.warnings.map((text) => h('div', { class: 'note' }, icon('warn'), h('div', null, text)))) : h('div', { class: 'note info' }, icon('check'), h('div', null, 'No warnings.')))),
      card(`Transactions${plan.ready ? '' : ' (fix the warnings first)'}`, h('div', { class: 'steps' }, plan.steps.map((step) => h('div', { class: 'step' }, h('div', null,
        h('b', null, step.description), step.value !== '0' ? h('span', { class: 'muted' }, ` · sends ${num(Number(step.value) / 1e18)} ETH`) : null,
        signer === 'mm'
          ? h('div', { class: 'cmd' }, h('code', null, step.mm), copyButton(step.mm, 'Copy command'))
          : h('div', { style: { display: 'grid', gap: '4px', marginTop: '6px' } }, [['to', step.to], ['value', step.value], ['data', step.data]].map(([label, text]) => h('div', { class: 'cmd' }, h('span', { class: 'muted', style: { width: '42px' } }, label), h('code', null, text), copyButton(text, `Copy ${label}`)))))))),
        { sub: `in order, from ${short(plan.wallet)}` }),
      h('div', { class: 'note info' }, icon('info'), h('div', null, 'Nothing has been signed or sent. Sign each transaction in order and wait for it to confirm.', sim.status === 'after-approvals' ? ' After the approvals confirm, build the plan again: the mint is rebuilt at the latest price and simulated.' : '', signer === 'mm' ? ' Check any step with mm decode --payload <data>.' : '')),
    );
  }

  if (ctx.params.pair || ctx.params.pool) void build();
  else clear(hint).append(cliHint(cli(request())));
  return () => controller?.abort();
}
