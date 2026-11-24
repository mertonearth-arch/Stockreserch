'use strict';
// Pure logic for the small-float scanner. No network in this file, so all of it
// is unit-tested (lib/scan.test.js); bin/scan.js does the fetching.
//
// What it decides:
//   - WHICH names qualify: float <= 50M shares, or market cap <= $300M.
//   - WHAT KIND of event a headline is (order, FDA approval, offering, reverse
//     split...), by keyword. A type label, not a judgement of the company.
//   - WHICH reported quarter shows a qualifying change (revenue growth,
//     a turn to profit, a narrowing loss), from the published numbers.
//
// What it deliberately does not do: score, rate, rank by quality or recommend.
// "positive-type" means the event is of a kind normally reported as good news
// (an approval, an order, record revenue). It says nothing about whether the
// stock is worth owning, and the dilution list sits right beside it.

const DEFAULTS = {
  maxFloatShares: 50e6,        // the user's line: float under 50M shares...
  maxMarketCap: 300e6,         // ...or market cap under $300M
  // A low share count alone does not make a low-float name: NVR, AutoZone and
  // FICO all have < 50M shares and are $15B+ companies. Above this cap the
  // float route stops qualifying a name.
  floatRouteMaxMarketCap: 2e9,
  minChangePct: 5,             // screener universe: names up at least this much
  minPrice: 0.5,
  minDollarVolume: 250000,     // filters out moves on a few hundred shares
  exchanges: ['NMS', 'NGM', 'NCM', 'NYQ', 'ASE'], // Nasdaq tiers, NYSE, NYSE American — no OTC
  screenPages: 2,
  maxCandidates: 220,          // per run, after prefiltering
  maxNewPerRun: 8,             // new names added to the watchlist per run
  lookbackHoursCap: 72,        // Monday AM reaches back over the weekend
  defaultLookbackHours: 24,
  overlapMinutes: 30,          // re-read the edge of the previous window
  minRevenueYoYPct: 25,
  minLossNarrowPct: 25,
  dilutionLookbackDays: 90,
  newsPerTicker: 12,
};

function config(overrides) {
  return Object.assign({}, DEFAULTS, overrides || {});
}

// --- small helpers ---------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const n = (v) => (isNum(v) ? v : null);
const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
function short(v) {
  if (!isNum(v)) return '?';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}
const round = (v, dp) => (isNum(v) ? Number(v.toFixed(dp === undefined ? 2 : dp)) : null);

// The calendar date in New York, which is what a US catalyst is dated by.
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyDate = (iso) => (iso ? NY.format(new Date(iso)) : null);

// --- listing filter -------------------------------------------------------------
// Common stock on a listed exchange only. Nasdaq's fifth-letter codes mark
// warrants (W), units (U), rights (R) and other non-common lines (Q, Z);
// Yahoo writes preferreds and NYSE warrants with a dash ("COF-PL", "ABC-WT").
function isCommonListing(symbol, exchange, cfg) {
  cfg = cfg || DEFAULTS;
  if (exchange && cfg.exchanges.indexOf(exchange) === -1) return false;
  const s = String(symbol || '').toUpperCase();
  if (/^[A-Z]{1,4}$/.test(s)) return true;
  if (/^[A-Z]{4}[A-Z]$/.test(s)) return 'QRUWZ'.indexOf(s[4]) === -1;
  if (/^[A-Z]{1,4}-[ABC]$/.test(s)) return true; // share classes, e.g. BRK-B
  return false;
}

// --- qualification ------------------------------------------------------------
// m: { floatShares, sharesOutstanding, marketCap }
function qualify(m, cfg) {
  cfg = cfg || DEFAULTS;
  const fl = n(m.floatShares);
  const so = n(m.sharesOutstanding);
  const mc = n(m.marketCap);
  const by = [];
  let excluded = null;
  const capOk = mc === null || mc <= cfg.floatRouteMaxMarketCap;

  if (fl !== null) {
    if (fl <= cfg.maxFloatShares) {
      if (capOk) by.push('float ' + short(fl) + ' <= ' + short(cfg.maxFloatShares));
      else excluded = 'float ' + short(fl) + ' but market cap $' + short(mc) + ' > $' + short(cfg.floatRouteMaxMarketCap) + ' — a large company with few shares, not a low-float name';
    }
  } else if (so !== null && so <= cfg.maxFloatShares) {
    // Float is a subset of shares outstanding, so this is a guarantee, not an estimate.
    if (capOk) by.push('shares outstanding ' + short(so) + ' <= ' + short(cfg.maxFloatShares) + ' (float can only be lower)');
    else excluded = 'shares outstanding ' + short(so) + ' but market cap $' + short(mc) + ' > $' + short(cfg.floatRouteMaxMarketCap);
  }
  if (mc !== null && mc <= cfg.maxMarketCap) by.push('market cap $' + short(mc) + ' <= $' + short(cfg.maxMarketCap));
  return { ok: by.length > 0, by: by, excluded: excluded };
}

// Cheap first cut on a screener quote, before spending a request on key stats.
// Deliberately loose on shares (150M): float can sit far below shares outstanding
// when insiders hold most of the stock, and only key stats reveal it.
function prefilter(q, cfg) {
  cfg = cfg || DEFAULTS;
  if (!isCommonListing(q.symbol, q.exchange, cfg)) return false;
  const px = n(q.regularMarketPrice);
  if (px !== null && px < cfg.minPrice) return false;
  const vol = n(q.regularMarketVolume);
  if (px !== null && vol !== null && px * vol < cfg.minDollarVolume) return false;
  const mc = n(q.marketCap);
  const so = n(q.sharesOutstanding);
  if (mc !== null && mc <= cfg.maxMarketCap) return true;
  if (so !== null && so <= cfg.maxFloatShares * 3 && (mc === null || mc <= cfg.floatRouteMaxMarketCap)) return true;
  return mc === null && so === null;
}

// --- headline classification ------------------------------------------------------
// Each rule: { type, tone, re, unless }. Tones:
//   dilution  — new shares or the right to issue them (offerings, ATMs, warrant deals, PIPEs)
//   negative  — listing notices, reverse splits, failed trials, going concern, guidance cuts
//   positive  — positive-type events (see header)
//   neutral   — real company news of no inherent direction (an earnings release before the numbers are read)
//   noise     — scheduling, conference appearances, law-firm solicitations
const RULES = [
  { type: 'law-firm notice', tone: 'noise', re: /\b(class action|investor alert|shareholder alert|shareholders? (are )?encouraged to contact|securities (fraud|litigation)|investigation (of|on behalf)|pomerantz|rosen law|levi & korsinsky|bronstein|faruqi|kirby mcinerney|bragar|glancy|schall law|gross law|portnoy law|robbins geller|howard g\. smith|kessler topaz|block & leviton)\b/i },

  { type: 'offering', tone: 'dilution', unless: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|s|led|ling|lation of)?|withdraw(s|n|al of)?|no shares (were )?sold)\b/i, re: /\b(public offering|registered direct|private placement|underwritten offering|best[- ]efforts offering|follow[- ]on offering|offering of (common|ordinary|american depositary)|pricing of|prices? (its |an |a )?(upsized |proposed |\$[\d.,]+\s*(million|m|billion)? )*(public |registered |underwritten |direct )*offering|proposed offering|closes? (its |an |a )?(\$[\d.,]+\s*(million|m|billion)? )?(public |registered direct |underwritten )?offering|PIPE financing)\b/i },
  { type: 'equity line / ATM', tone: 'dilution', unless: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|s|led|ling|lation of)?|withdraw(s|n|al of)?|no shares (were )?sold)\b/i, re: /\b(at[- ]the[- ]market (offering|program|facility|equity|sales)|\bATM (program|offering|facility)\b|equity line|\bELOC\b|standby equity|equity purchase agreement|securities purchase agreement|committed equity facility)\b/i },
  { type: 'warrants / convertibles', tone: 'dilution', unless: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|s|led|ling|lation of)?|withdraw(s|n|al of)?|no shares (were )?sold)\b/i, re: /\b(warrant inducement|inducement (of|letter)|exercise of (outstanding |existing )?warrants|warrant exercise|convertible (senior )?(notes?|debentures?|preferred)|shelf registration|files? (a |an )?(s-1|s-3|f-1|f-3)\b)/i },

  // Ending an ATM / offering / shelf removes a source of new shares.
  { type: 'dilution withdrawn', tone: 'positive', re: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|led|ling|lation of)?|withdraw(s|n|al of)?)\b.{0,50}\b(at[- ]the[- ]market|ATM|offering|equity line|shelf|registration statement|equity purchase agreement)\b/i },
  { type: 'reverse split', tone: 'negative', re: /\breverse (stock |share )?split\b/i },
  { type: 'listing notice', tone: 'negative', unless: /\bregain(s|ed)?\b/i, re: /\b(deficiency|non-?compliance|delist|minimum bid price|notice from (the )?(nasdaq|nyse)|nasdaq (hearings? )?panel|(stockholders|shareholders)'? equity requirement|suspension of trading)\b/i },
  { type: 'going concern / bankruptcy', tone: 'negative', re: /\b(going concern|chapter (7|11|15)|bankruptcy|insolven|wind[- ]down|liquidat(e|ion|ing)|receivership)\b/i },
  { type: 'clinical / regulatory setback', tone: 'negative', re: /\b(complete response letter|\bCRL\b|clinical hold|did not (meet|achieve)|failed to (meet|achieve)|miss(ed|es)? (its |the )?primary endpoint|discontinu(e|es|ed|ing) (the |its )?(development|trial|study|program)|refusal to file|not approvable|fda (rejects|rejected|declines|denies|denied)|rejects? (\w+ ){0,3}approval|refuses? to approve)\b/i },
  { type: 'guidance cut', tone: 'negative', re: /\b(lowers|cuts|reduces|withdraws|suspends) (its )?((full[- ]year|fy\s?\d{0,4}|annual|fiscal|year|\d{4})\s)*(revenue |sales |earnings |ebitda )?(guidance|outlook|forecast)\b/i },
  { type: 'restatement / auditor', tone: 'negative', re: /\b(restate(s|d|ment)?|non-?reliance|auditor (resign|dismiss)|material weakness)\b/i },
  { type: 'insider selling', tone: 'negative', re: /\b(insiders? (sold|sells|selling|unloads?)|(ceo|cfo|director|chairman|founder) (sold|sells|unloads?) (\w+ ){0,3}(shares|stock))\b/i },
  { type: 'analyst action', tone: 'negative', tag: 'third-party opinion', re: /\b(downgrades?|downgraded|(cuts?|lowers?|slashes) (\w+ ){0,3}(price )?target|target cuts?)\b/i },
  { type: 'executive exit', tone: 'negative', re: /\b(ceo|cfo|chief executive|chief financial)[^.]{0,30}\b(resign|steps? down|terminated|departs?|exit)/i },

  // Earnings with a direction in the headline itself.
  { type: 'earnings', tone: 'negative', tag: 'weak print', re: /\b((revenue|sales) (fell|falls|declined|declines|decreased|decreases|down|dropped|slipped)|(miss(es|ed)?|lag(s|ged)?|below|trail(s|ed)?) (\w+ )?(estimates|expectations|consensus)|wider (net |quarterly )?loss|loss widen(s|ed))\b/i },
  { type: 'earnings', tone: 'positive', tag: 'strong print', re: /\b(record (\w+ )?(revenue|quarter|sales|results|bookings|backlog|orders)|(revenue|sales|bookings) (grew|grows|increased|increases|rose|rises|up|jumped|surged|soared|doubled|tripled)|(grew|increased|doubled) (its )?(revenue|sales)|returns? to profitab|first (ever |quarterly |full[- ]year )?(profit|profitable|net income)|positive (net income|ebitda|operating income|free cash flow|cash flow)|(beats?|tops?|exceed(s|ed)?|surpass(es|ed)?) (\w+ )?(estimates|expectations|consensus|guidance)|narrow(s|ed|er) (net |quarterly )?loss|loss (narrow(s|ed|er)|shrank|shrinks|improved)|raises? (its )?((full[- ]year|fy\s?\d{0,4}|annual|fiscal|year|\d{4})\s)*(revenue |sales |earnings |ebitda )?(guidance|outlook|forecast))\b/i },

  { type: 'M&A (target)', tone: 'positive', re: /\b(to be acquired|agrees? to be acquired|(definitive )?(merger )?agreement to be acquired|acquired by|take[- ]private|go(ing)?[- ]private (transaction|deal)|tender offer (for|to acquire) (all|the outstanding))\b/i },
  { type: 'regulatory / clinical', tone: 'positive', unless: /\b(shareholder|stockholder|transfer (its |of )?listing|board approv)/i, re: /\b(fda (approv|clear|grant|accept)|(receives?|granted|wins?) (\w+ ){0,3}(approval|clearance|designation)|510\(k\)|de novo|breakthrough (therapy|device) designation|fast track|orphan drug|rare pediatric|priority review|positive (topline|top-line|interim|final|phase|pivotal|clinical)?\s?(data|results|readout)|met (its |the |all )?(primary|co-primary) endpoints?|statistically significant|ce mark|ind (clearance|approval)|emergency use authori[sz]ation|fda agreement|agreement with (the )?fda|alignment with (the )?fda|accelerated approval (pathway|path)|(successful|positive) end[- ]of[- ]phase)\b/i },
  { type: 'order / contract', tone: 'positive', unless: /\b(merger|business combination|to acquire|acquisition of|reverse merger|to present|conference|best (places|workplaces)|named (to|as|one)|recogni[sz]ed)\b/i, re: /\b(award(ed|s)? (a |an |the )?(\$?[\d.,]+\s*(million|m|billion|bn|k)?\s*)?([\w-]+ ){0,4}(contract|order|grant|task order|agreement|program)|contract (award|win)|wins? (\w+ ){0,4}(contract|order|award|tender|deal)|(purchase|production|follow[- ]on) orders?|secures? (\w+ ){0,5}(contract|order|deal|award|agreement|customer)|receives? (\w+ ){0,5}(order|contract|award)|selected (by|as)|supply (agreement|contract)|distribution agreement|licens(e|ing) agreement|master (services|supply) agreement|offtake agreement|definitive agreement with|signs? (\w+ ){0,4}(agreement|contract|deal))\b/i },
  { type: 'renewal / extension', tone: 'positive', re: /\b(extend(s|ed|ing)?|extension of|renew(s|ed|ing|al of)?|expand(s|ed|ing)?)\b.{0,50}\b(partnership|agreement|contract|licen[cs]e|collaboration|relationship)\b/i },
  { type: 'partnership', tone: 'positive', tag: 'often non-binding', unless: /\b(merger|business combination)\b/i, re: /\b(announces?|enters? into|forms?|launch(es)?|signs?)\b.{0,80}\b(partnerships?|alliances?|collaborations?|cooperation (agreement|framework)?)\b/i },
  { type: 'partnership', tone: 'positive', tag: 'often non-binding', re: /\b(partner(s|ship|ing)? with|strategic (partnership|alliance|collaboration|investment)|collaborat(ion|es|e|ing) with|joint venture|teams? up|memorandum of understanding|\bMOU\b|letter of intent|\bLOI\b|term sheet)\b/i },
  { type: 'buyback / dividend', tone: 'positive', re: /\b(share repurchase|stock repurchase|buyback|repurchase (program|plan|authori[sz]ation)|special (cash )?dividend|initiates? (a |its first )?(quarterly |annual )?dividend|increases? (its )?(quarterly )?dividend)\b/i },
  { type: 'listing / index', tone: 'positive', re: /\b(regain(s|ed)? compliance|uplist|approved (for listing|to list) on|begins trading on (the )?(nasdaq|nyse)|(added to|join(s|ing)?|inclusion in) (the )?(russell|s&p|msci|nasdaq[- ]100))\b/i },
  { type: 'patent', tone: 'positive', re: /\b(patent (granted|issued|allowance)|(issued|grants?|granted|receives?) (a |an |\w+ )?(u\.s\. |us |european |japanese |chinese )?patent|notice of allowance)\b/i },
  { type: 'insider buying', tone: 'positive', re: /\b(insider (purchase|buying)|(ceo|cfo|director|chairman|insiders?) (buys|bought|purchases|purchased|acquires|acquired) (\w+ ){0,3}(shares|stock)|open[- ]market purchase)\b/i },
  { type: 'launch / milestone', tone: 'positive', tag: 'weak signal', re: /\b(commercial (launch|availability|shipments?)|first (patient (dosed|enrolled)|commercial|shipment|delivery|deliveries|revenue)|launch(es|ed)?\b|achieves? (\w+ ){0,3}milestone|completes? enrollment|successfully (completes?|completed))/i },

  { type: 'analyst action', tone: 'positive', tag: 'third-party opinion', re: /\b(upgrades?|upgraded|raises? (\w+ ){0,3}price target|initiates? coverage (\w+ ){0,5}(buy|outperform|overweight))\b/i },
  { type: 'M&A (acquirer)', tone: 'neutral', re: /\b(to acquire|acquires|acquisition of|completes? (the )?acquisition|merger agreement|business combination|reverse merger)\b/i },
  { type: 'call logistics', tone: 'noise', re: /\b(will|to) (host|hold) .{0,40}(conference call|webcast|call) (on|at|today|tomorrow)\b/i },
  { type: 'scheduling / IR', tone: 'noise', re: /\b(to (report|announce|release) .{0,60}(results|earnings)|to (present|participate|ring|speak|exhibit) (at|in|the)|fireside chat|investor (conference|day|summit)|announces? (the )?(date|timing) (of|for)|schedules? .{0,40}(call|webcast|release)|webinar|annual (general |shareholder )?meeting)\b/i },
  { type: 'earnings', tone: 'neutral', re: /\b(reports?|announces?|posts?|delivers?|releases?)\b.{0,60}\b(results|earnings)\b|\b(first|second|third|fourth|q[1-4])[- ]quarter (\d{4} |fiscal )?(results|earnings|revenue)\b/i },
];

const TONE_ORDER = ['dilution', 'negative', 'positive', 'neutral', 'noise'];

function classify(text) {
  const t = String(text || '');
  const hits = RULES.filter((r) => r.re.test(t) && !(r.unless && r.unless.test(t)));
  if (!hits.length) return { type: 'other', tone: 'neutral', tags: [] };
  const tags = hits.map((h) => h.tag ? h.type + ' (' + h.tag + ')' : h.type)
    .filter((v, i, a) => a.indexOf(v) === i);
  // Law-firm solicitations mention fraud and lawsuits; they are not company news.
  if (hits[0].type === 'law-firm notice') return { type: 'law-firm notice', tone: 'noise', tags: tags };
  const has = (tone) => hits.filter((h) => h.tone === tone);
  const dil = has('dilution');
  if (dil.length) return { type: dil[0].type, tone: 'dilution', tags: tags };
  const neg = has('negative');
  const pos = has('positive');
  const weakPrint = neg.filter((h) => h.type === 'earnings');
  const otherNeg = neg.filter((h) => h.type !== 'earnings');
  if (otherNeg.length) return { type: otherNeg[0].type, tone: 'negative', tags: tags };
  if (pos.length && weakPrint.length) return { type: 'earnings', tone: 'mixed', tags: tags };
  if (pos.length) return { type: pos[0].type, tone: 'positive', tags: tags };
  if (weakPrint.length) return { type: 'earnings', tone: 'negative', tags: tags };
  const neu = has('neutral');
  const noise = has('noise');
  // "to report Q3 results on Nov 13" is scheduling, even though it says "results";
  // "reports Q3 results and will host a call on…" is an earnings release.
  const strongNoise = noise.filter((h) => h.type !== 'call logistics');
  if (strongNoise.length && neu.every((h) => h.type === 'earnings')) return { type: strongNoise[0].type, tone: 'noise', tags: tags };
  if (neu.length) return { type: neu[0].type, tone: 'neutral', tags: tags };
  return { type: noise[0].type, tone: 'noise', tags: tags };
}

// --- who said it ------------------------------------------------------------------
const WIRES = /\b(globe ?newswire|pr ?newswire|business ?wire|access ?newswire|accesswire|newsfile|cision|eqs|issuer direct|notified|marketwired)\b/i;
const COMMENTARY = /\b(motley fool|gurufocus|simply wall|seeking alpha|insider monkey|tipranks|marketbeat|moby|stocktitan|investorplace|24\/7 wall|validea|finbold|benzinga insights|stockstory|stocknews|kiplinger|barchart insights)\b/i;
function sourceClass(publisher) {
  const p = String(publisher || '');
  if (WIRES.test(p)) return 'company release';
  if (COMMENTARY.test(p)) return 'commentary';
  return 'media';
}

// --- SEC filings --------------------------------------------------------------------
const ITEMS = {
  '1.01': ['material agreement', 'neutral'], '1.02': ['agreement terminated', 'negative'],
  '1.03': ['bankruptcy / receivership', 'negative'], '2.01': ['acquisition or disposition completed', 'neutral'],
  '2.02': ['results of operations', 'neutral'], '2.03': ['new debt obligation', 'neutral'],
  '2.05': ['exit / restructuring costs', 'negative'], '2.06': ['material impairment', 'negative'],
  '3.01': ['listing deficiency / delisting notice', 'negative'], '3.02': ['unregistered sale of equity', 'dilution'],
  '3.03': ['change to shareholder rights', 'negative'], '4.01': ['auditor change', 'negative'],
  '4.02': ['non-reliance on prior financials', 'negative'], '5.01': ['change in control', 'neutral'],
  '5.02': ['officer / director change', 'neutral'], '5.03': ['charter or bylaw amendment', 'neutral'],
  '5.07': ['shareholder vote results', 'neutral'], '7.01': ['Reg FD disclosure', 'neutral'],
  '8.01': ['other events', 'neutral'],
};
const DILUTION_FORMS = /^(S-1|S-3|F-1|F-3|S-3ASR|424B[1-8]|FWP)(\/A)?$/;

function describe8K(items) {
  const list = (items || []).filter((i) => i !== '9.01');
  const labels = list.map((i) => i + ' ' + (ITEMS[i] ? ITEMS[i][0] : 'item'));
  let tone = 'neutral';
  list.forEach((i) => {
    const t = ITEMS[i] ? ITEMS[i][1] : 'neutral';
    if (TONE_ORDER.indexOf(t) < TONE_ORDER.indexOf(tone)) tone = t;
  });
  // 1.01 + 3.02 together is the usual shape of a private placement.
  if (list.indexOf('1.01') !== -1 && list.indexOf('3.02') !== -1) tone = 'dilution';
  return { label: labels.join('; ') || 'exhibits only', tone: tone, earnings: list.indexOf('2.02') !== -1 };
}

// Filings over the dilution lookback that bear on share count. Facts only.
function dilutionCheck(filings, today, cfg) {
  cfg = cfg || DEFAULTS;
  const recent = (filings || []).filter((f) => f.filingDate && daysBetween(f.filingDate, today) <= cfg.dilutionLookbackDays);
  const out = [];
  recent.forEach((f) => {
    if (DILUTION_FORMS.test(f.form)) out.push({ form: f.form, date: f.filingDate, url: f.url, why: f.form.indexOf('424B') === 0 ? 'prospectus (offering terms)' : 'registration / shelf' });
    else if (/^8-K/.test(f.form)) {
      if (f.items.indexOf('3.02') !== -1) out.push({ form: f.form, date: f.filingDate, url: f.url, why: 'item 3.02 unregistered equity sale' });
      if (f.items.indexOf('3.01') !== -1) out.push({ form: f.form, date: f.filingDate, url: f.url, why: 'item 3.01 listing deficiency notice' });
      if (f.items.indexOf('3.03') !== -1 || f.items.indexOf('5.03') !== -1) out.push({ form: f.form, date: f.filingDate, url: f.url, why: 'item ' + (f.items.indexOf('3.03') !== -1 ? '3.03' : '5.03') + ' (reverse splits are filed under this; check)' });
    }
  });
  return { flagged: out.length > 0, days: cfg.dilutionLookbackDays, filings: out.slice(0, 8) };
}

// --- financials ------------------------------------------------------------------------
// fin: { TotalRevenue:[{asOfDate,value}], NetIncome, DilutedEPS, OrdinarySharesNumber, CashAndCashEquivalents }
function financialDeltas(fin, eventDate, cfg) {
  cfg = cfg || DEFAULTS;
  if (!fin) return null;
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const yearAgo = (a, d) => (a || []).filter((v) => Math.abs(daysBetween(v.asOfDate, d) - 365) <= 25).pop() || null;
  const rev = fin.TotalRevenue || [];
  const ni = fin.NetIncome || [];
  const anchor = last(rev) || last(ni);
  if (!anchor) return null;
  const period = anchor.asOfDate;
  const at = (a) => (a || []).filter((v) => v.asOfDate === period).pop() || null;

  const r0 = at(rev);
  const r1 = yearAgo(rev, period);
  const i0 = at(ni);
  const i1 = yearAgo(ni, period);
  const s0 = last(fin.OrdinarySharesNumber);
  const s1 = s0 ? yearAgo(fin.OrdinarySharesNumber, s0.asOfDate) : null;
  const c0 = last(fin.CashAndCashEquivalents);

  const revenueYoY = r0 && r1 && r1.value > 0 ? round((r0.value / r1.value - 1) * 100, 1) : null;
  const turnedProfitable = i0 && i1 ? i0.value > 0 && i1.value <= 0 : false;
  const lossNarrowedPct = i0 && i1 && i0.value < 0 && i1.value < 0 ? round((1 - i0.value / i1.value) * 100, 1) : null;
  const sharesYoY = s0 && s1 && s1.value > 0 ? round((s0.value / s1.value - 1) * 100, 1) : null;
  // Yahoo can lag a fresh report by days. If the newest quarter on file ended
  // long before the release, these numbers describe the PREVIOUS report.
  const stale = eventDate ? daysBetween(period, eventDate) > 135 : false;

  const reasons = [];
  if (isNum(revenueYoY) && revenueYoY >= cfg.minRevenueYoYPct) reasons.push('revenue +' + revenueYoY + '% YoY');
  if (turnedProfitable) reasons.push('net income turned positive');
  if (isNum(lossNarrowedPct) && lossNarrowedPct >= cfg.minLossNarrowPct && (revenueYoY === null || revenueYoY >= 0)) {
    reasons.push('net loss narrowed ' + lossNarrowedPct + '% YoY');
  }

  const facts = [];
  if (r0) facts.push('Revenue $' + short(r0.value) + (r1 ? ' vs $' + short(r1.value) + ' a year earlier' + (isNum(revenueYoY) ? ' (' + (revenueYoY > 0 ? '+' : '') + revenueYoY + '%)' : '') : ''));
  if (i0) facts.push('Net income $' + short(i0.value) + (i1 ? ' vs $' + short(i1.value) + ' a year earlier' : ''));
  if (s0 && s1) facts.push('Shares ' + short(s0.value) + ' vs ' + short(s1.value) + ' a year earlier (' + (sharesYoY > 0 ? '+' : '') + sharesYoY + '%)');
  if (c0) facts.push('Cash $' + short(c0.value) + ' at ' + c0.asOfDate);

  return {
    period: 'quarter ended ' + period, periodEnd: period, source: 'Yahoo Finance fundamentals',
    revenue: r0 ? r0.value : null, revenueYearAgo: r1 ? r1.value : null, revenueYoY: revenueYoY,
    netIncome: i0 ? i0.value : null, netIncomeYearAgo: i1 ? i1.value : null,
    turnedProfitable: turnedProfitable, lossNarrowedPct: lossNarrowedPct,
    shares: s0 ? s0.value : null, sharesYoY: sharesYoY, cash: c0 ? c0.value : null,
    stale: stale, qualifies: !stale && reasons.length > 0, reasons: reasons, facts: facts,
  };
}

// --- events ------------------------------------------------------------------------------
// Yahoo tags a story with every ticker it mentions — a Best Buy earnings piece
// arrives tagged FOSL. A story counts for a company only if the headline names
// it: the ticker as a word, or the company's name.
const NAME_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\s?v|s\s?a|ag|se|llc|lp|trust|technologies|international|intl|the)\b/gi;
const GENERIC = new Set(['first', 'american', 'global', 'united', 'national', 'new', 'general', 'advanced', 'applied',
  'digital', 'energy', 'capital', 'financial', 'health', 'healthcare', 'medical', 'pharma', 'therapeutics', 'sciences',
  'systems', 'solutions', 'industries', 'resources', 'partners', 'one', 'china', 'north', 'south', 'west', 'east', 'smart', 'bio']);
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nameStems(name) {
  const words = String(name || '').replace(/[,.()'’&]/g, ' ').replace(NAME_SUFFIX, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const stems = [];
  if (words.length >= 2) stems.push(words.slice(0, 2).join(' '));
  if (words[0] && words[0].length >= 4 && !GENERIC.has(words[0].toLowerCase())) stems.push(words[0]);
  if (words.length === 1 && words[0].length >= 3) stems.push(words[0]);
  return stems;
}
function aboutCompany(headline, ticker, name) {
  const h = String(headline || '');
  const t = String(ticker || '');
  if (t.length >= 3 && new RegExp('(^|[^A-Za-z])' + escRe(t) + '([^A-Za-z]|$)').test(h)) return true;
  const low = h.toLowerCase();
  return nameStems(name).some((st) => new RegExp('(^|[^a-z])' + escRe(st.toLowerCase()) + '([^a-z]|$)').test(low));
}

function newsEvents(items, window, subject) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return (items || [])
    .filter((it) => it.publishedAt && Date.parse(it.publishedAt) >= from && Date.parse(it.publishedAt) <= to)
    .filter((it) => !subject || aboutCompany(it.title, subject.ticker, subject.name))
    .map((it) => {
      const c = classify(it.title);
      return {
        date: nyDate(it.publishedAt), at: it.publishedAt, origin: 'news', publisher: it.publisher,
        sourceClass: sourceClass(it.publisher), headline: it.title, url: it.url,
        type: c.type, tone: c.tone, tags: c.tags,
      };
    });
}

function secEvents(filings, window) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return (filings || [])
    .filter((f) => {
      const t = Date.parse(f.acceptance || (f.filingDate + 'T12:00:00Z'));
      return t >= from && t <= to;
    })
    .map((f) => {
      let d = { label: f.description || f.form, tone: 'neutral', earnings: false };
      if (/^8-K/.test(f.form)) d = describe8K(f.items);
      else if (DILUTION_FORMS.test(f.form)) d = { label: 'registration / prospectus', tone: 'dilution', earnings: false };
      else if (/^10-[QK]/.test(f.form)) d = { label: 'periodic report', tone: 'neutral', earnings: true };
      return {
        date: f.filingDate, at: f.acceptance || null, origin: 'sec', publisher: 'SEC EDGAR', sourceClass: 'SEC filing',
        headline: f.form + ': ' + d.label, url: f.url, form: f.form, items: f.items || [],
        type: d.earnings ? 'earnings' : (d.tone === 'dilution' ? 'offering' : 'filing'), tone: d.tone, tags: [],
      };
    });
}

// --- decision --------------------------------------------------------------------------
const WEAK_ONLY = ['analyst action', 'launch / milestone'];
function decide(c, cfg) {
  cfg = cfg || DEFAULTS;
  const ev = c.events || [];
  // Two outlets describing one print differently ("loss widens" vs "beats
  // revenue estimates") is a contested print, not good news on its own.
  const contested = ev.some((e) => e.type === 'earnings' && (e.tone === 'negative' || e.tone === 'mixed'));
  const positives = ev.filter((e) => e.tone === 'positive' && e.sourceClass !== 'commentary' &&
    !(contested && e.type === 'earnings'));
  // An analyst's upgrade or a product launch is the weakest kind of "good news":
  // listed as a weak signal, but never enough on its own to add a name.
  const strongPositives = positives.filter((e) => WEAK_ONLY.indexOf(e.type) === -1);
  const negatives = ev.filter((e) => e.tone === 'dilution' || e.tone === 'negative');
  const hasEarnings = ev.some((e) => e.type === 'earnings');
  const fin = c.financials;
  const finHit = !!(hasEarnings && fin && fin.qualifies);
  const why = [];
  positives.slice(0, 3).forEach((e) => why.push(e.type + ': ' + e.headline));
  if (finHit) why.push('financials: ' + fin.reasons.join(', ') + ' (' + fin.period + ')');
  return { hit: strongPositives.length > 0 || finHit, weakOnly: !finHit && !strongPositives.length && positives.length > 0,
    finHit: finHit, contested: contested, positives: positives, negatives: negatives, why: why };
}

// The most relevant reported move for this run: extended hours when the run
// sits outside the session, else the regular-session change.
function reaction(k) {
  const ext = [k.postMarketChangePct, k.preMarketChangePct].filter(isNum);
  return { regular: n(k.changePct), extended: ext.length ? ext[0] : null };
}

// Display order only — not a rating. Primary-source positive events first,
// then the size of the price reaction, then the smaller share base.
const WEAK = ['launch / milestone', 'analyst action', 'partnership'];
const strong = (e) => WEAK.indexOf(e.type) === -1;
function order(a, b) {
  const st = (x) => x.decision.positives.filter(strong).length + (x.decision.finHit ? 1 : 0);
  const prim = (x) => x.decision.positives.filter((e) => e.sourceClass === 'company release' || e.sourceClass === 'SEC filing').length;
  if (st(b) !== st(a)) return st(b) - st(a);
  const mv = (x) => Math.max(Math.abs(x.reaction.regular || 0), Math.abs(x.reaction.extended || 0));
  const base = (x) => n(x.metrics.floatShares) || n(x.metrics.sharesOutstanding) || Infinity;
  return (prim(b) - prim(a)) || (b.decision.positives.length - a.decision.positives.length) || (mv(b) - mv(a)) || (base(a) - base(b));
}

// --- batch for the engine ----------------------------------------------------------------
// A tracked name only ever gets new dated events (and filings) from a scan —
// never prices or fundamentals, which change every day and would reset the
// cadence ladder's quiet counter. New names get a full seed.
function toBatchResult(h, isNew, today) {
  const catalysts = h.events
    .filter((e) => e.tone !== 'noise' && e.origin === 'news')
    .map((e) => ({
      date: e.date, type: e.type, headline: e.headline, impact: null, source: e.url,
      publisher: e.publisher, via: 'small-float scan (keyword-classified; verify on the next full pass)',
    }));
  const pending = h.events.filter((e) => e.origin === 'sec')
    .map((e) => e.form + ' ' + e.date + (e.items && e.items.length ? ' (items ' + e.items.join(', ') + ')' : ''));
  const out = { ticker: h.ticker, catalysts: catalysts };
  if (pending.length) out.pendingFilings = pending;
  if (!isNew) return out;

  const m = h.metrics;
  const asOf = today;
  out.name = m.name || null;
  out.sector = m.sector || null;
  out.addedReason = 'small-float scan ' + today + ': ' + (h.decision.why[0] || 'qualifying event');
  if (isNum(m.marketCap) && m.marketCap < 50e6) out.themeLabel = 'nano-cap';
  if (isNum(m.price)) {
    out.price = { last: m.price, changePct: round(m.changePct, 2), asOf: nyDate(m.priceTime) || asOf, source: 'Yahoo Finance (scan)' };
    if (isNum(h.reaction.extended)) out.price.note = 'extended-hours move ' + round(h.reaction.extended, 1) + '%';
  }
  const f = {};
  f.marketCap = isNum(m.marketCap) ? { value: m.marketCap, asOf: asOf, source: m.metricsSource } : { value: null, note: 'not available at scan time' };
  f.float = isNum(m.floatShares) ? { value: m.floatShares, asOf: asOf, source: m.metricsSource }
    : { value: null, note: 'float not available at scan time; shares outstanding is the upper bound' };
  if (isNum(m.sharesOutstanding)) f.sharesOutstanding = { value: m.sharesOutstanding, asOf: m.sharesAsOf || asOf, source: m.metricsSource };
  if (isNum(m.shortPercentOfFloat)) f.shortInterest = { value: round(m.shortPercentOfFloat, 1), asOf: m.dateShortInterest || asOf, note: '% of float (Yahoo)' };
  out.fundamentals = f;
  out.notes = 'Seeded by the small-float scan from Yahoo Finance' + (m.industry ? ' (industry: ' + m.industry + ')' : '') +
    '. Headlines were keyword-classified; the next full pass verifies them and assigns a theme.';
  return out;
}

module.exports = {
  DEFAULTS, config, isCommonListing, qualify, prefilter, classify, sourceClass, describe8K, dilutionCheck,
  financialDeltas, newsEvents, secEvents, decide, reaction, order, toBatchResult, nyDate, short, daysBetween,
  aboutCompany, nameStems,
};
