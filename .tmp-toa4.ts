const KEY = process.env.ODDS_API_KEY as string;
const BASE = process.env.ODDS_API_BASE_URL as string;

async function main() {
  const evUrl = new URL(`${BASE.replace(/\/$/, '')}/sports/soccer_epl/events`);
  evUrl.searchParams.set('apiKey', KEY);
  const evRes = await fetch(evUrl.toString());
  const events = JSON.parse(await evRes.text()) as Array<{ id: string; home_team: string; away_team: string; commence_time: string }>;
  const target = events[0];
  if (!target) { console.log('no events'); return; }
  console.log(`event: ${target.home_team} v ${target.away_team} ${target.commence_time}`);

  const markets = ['btts_h1', 'btts_h2', 'correct_score_h1', 'totals_h1'];
  const url = new URL(`${BASE.replace(/\/$/, '')}/sports/soccer_epl/events/${target.id}/odds`);
  url.searchParams.set('apiKey', KEY);
  url.searchParams.set('regions', 'eu');
  url.searchParams.set('markets', markets.join(','));
  url.searchParams.set('oddsFormat', 'decimal');

  const res = await fetch(url.toString());
  const text = await res.text();
  console.log(`status=${res.status} cost=${res.headers.get('x-requests-last')} remaining=${res.headers.get('x-requests-remaining')}`);
  if (res.status !== 200) { console.log(text.slice(0, 400)); return; }

  const data = JSON.parse(text) as {
    bookmakers: Array<{ key: string; markets: Array<{ key: string; outcomes: Array<{ name: string; price: number; point?: number }> }> }>;
  };
  const seen = new Map<string, number>();
  for (const b of data.bookmakers ?? []) for (const m of b.markets ?? []) seen.set(m.key, (seen.get(m.key) ?? 0) + 1);
  console.log('markets returned:', JSON.stringify(Object.fromEntries(seen)));

  for (const b of (data.bookmakers ?? []).slice(0, 3)) {
    for (const m of b.markets ?? []) {
      if (m.key === 'correct_score_h1') {
        const twoTwo = m.outcomes.find((o) => /^2\s*[-:]\s*2$/.test(o.name.trim()));
        console.log(`  ${b.key} correct_score_h1: ${m.outcomes.length} outcomes | 2-2 => ${twoTwo ? twoTwo.price : 'NOT LISTED'}`);
        console.log(`    names: ${m.outcomes.slice(0, 10).map((o) => `${o.name}@${o.price}`).join(', ')}`);
      } else {
        console.log(`  ${b.key} ${m.key}: ${m.outcomes.map((o) => `${o.name}${o.point !== undefined ? ' ' + o.point : ''}@${o.price}`).join(', ')}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
