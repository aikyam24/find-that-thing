const STOP = new Set('a an the that this those these i me my it its was were is are be been being to of for from on in at with and or as about something thing website page tool looked saw read remember'.split(' '));

export function terms(text) {
  return [...new Set((text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => !STOP.has(word) && word.length > 1))];
}

export function excerptFor(text, query, limit = 350) {
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const matches = terms(query).map(term => lower.indexOf(term)).filter(index => index >= 0);
  let start = Math.max(0, (matches.length ? Math.min(...matches) : 0) - 70);
  if (start) {
    const space = text.indexOf(' ', start);
    if (space >= start && space < start + 30) start = space + 1;
  }
  return `${start ? '…' : ''}${text.slice(start, start + limit).trim()}${start + limit < text.length ? '…' : ''}`;
}

function relevance(text, words) {
  const tokens = new Set(terms(text));
  return words.reduce((score, word) => score + (tokens.has(word) ? 1 : 0), 0);
}

export function searchLocal(pages, query, { includeUnmatched = false, limit = 30 } = {}) {
  const words = terms(query);
  return pages.map(page => {
    const passages = page.chunks.map(chunk => ({ ...chunk, localScore: relevance(chunk.text, words) }))
      .sort((a, b) => b.localScore - a.localScore || a.ordinal - b.ordinal).slice(0, 2);
    const titleScore = relevance(page.title, words) * 2.5;
    const bodyScore = passages[0]?.localScore ?? 0;
    const score = titleScore + bodyScore + relevance(page.userNote || '', words) * 3;
    return { page, passages, localScore: score };
  }).filter(candidate => !query.trim() || includeUnmatched || candidate.localScore > 0)
    .sort((a, b) => b.localScore - a.localScore || b.page.capturedAt - a.page.capturedAt)
    .slice(0, limit);
}

export function toResult(candidate, judgement = null) {
  const page = candidate.page;
  const selected = candidate.passages.find(p => p.id === judgement?.bestPassageId) ?? candidate.passages[0];
  return {
    id: page.id, title: page.title, hostname: page.hostname, url: page.originalUrl,
    capturedAt: page.capturedAt, truncated: page.truncated,
    excerpt: selected?.text ?? '', localScore: candidate.localScore,
    judgement,
  };
}

export function rankEvaluated(items) {
  return items.filter(item => item.judgement.relevance >= 1.5)
    .sort((a, b) => {
      const contradiction = Number(a.judgement.detailSupport === 'contradicted') - Number(b.judgement.detailSupport === 'contradicted');
      return contradiction || b.judgement.relevance - a.judgement.relevance || b.localScore - a.localScore;
    });
}
