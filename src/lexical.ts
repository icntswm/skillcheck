// A tiny TF-IDF index: enough lexical signal to compare descriptions without
// pulling in a stemming or embeddings dependency.

const STOPWORDS = new Set([
  // Russian and English function words carry no routing signal. MR, CI, DB, PR
  // are two-letter but real, so tokenize keeps words of length >= 2 and the
  // common two-letter function words are listed here. ё folds to е before the
  // check, so the е spellings are listed.
  "и", "в", "на", "не", "что", "это", "как", "для", "по", "из", "или", "при", "об", "но", "же",
  "the", "and", "for", "with", "this", "that", "from", "into", "when", "use", "not", "are", "was",
  "за", "до", "от", "то", "ли", "бы", "мы", "вы", "он", "она", "оно", "они", "мой", "мои", "моих",
  "мое", "его", "ее", "их", "там", "тут", "вот", "уже", "еще", "так",
  "to", "of", "in", "on", "is", "it", "an", "as", "at", "be", "by", "or", "if", "do", "we",
  "you", "my", "me", "your", "our", "its",
]);

export function tokenize(text: string): string[] {
  // camelCase boundaries become spaces, and ё is treated as е
  const spaced = text.replace(/[ёЁ]/g, (c) => (c === "ё" ? "е" : "Е")).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const words = spaced.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    // crude stem: 5 chars is enough to tell inflections of one word from
    // different words, and a real stemmer is not worth the dependency
    .map((w) => (w.length > 5 ? w.slice(0, 5) : w));
}

/** Doc text = description plus the name itself, split on the usual separators. */
function docText(name: string, text: string): string {
  return `${text} ${name.split(/[-_:]/).join(" ")}`;
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function normalize(vec: Map<string, number>): void {
  let sum = 0;
  for (const w of vec.values()) sum += w * w;
  const norm = Math.sqrt(sum);
  if (norm === 0) return; // empty vector stays all-zero, cosine gives 0
  for (const [t, w] of vec) vec.set(t, w / norm);
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const wb = big.get(t);
    if (wb !== undefined) dot += w * wb;
  }
  return dot;
}

export class LexicalIndex {
  private readonly vectors = new Map<string, Map<string, number>>();
  private readonly idf = new Map<string, number>();

  constructor(docs: { name: string; text: string }[]) {
    const df = new Map<string, number>();
    const tfs = docs.map((d) => {
      const tf = termFreq(tokenize(docText(d.name, d.text)));
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      return { name: d.name, tf };
    });
    const n = docs.length;
    for (const [t, count] of df) this.idf.set(t, Math.log(1 + n / count));
    for (const { name, tf } of tfs) {
      const vec = new Map<string, number>();
      for (const [t, count] of tf) vec.set(t, count * (this.idf.get(t) ?? 0));
      normalize(vec);
      this.vectors.set(name, vec);
    }
  }

  rank(query: string): { name: string; score: number }[] {
    const q = this.vectorize(tokenize(query));
    const out = [...this.vectors.entries()].map(([name, vec]) => ({ name, score: cosine(q, vec) }));
    out.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
    return out;
  }

  similarity(a: string, b: string): number {
    const va = this.vectors.get(a);
    const vb = this.vectors.get(b);
    if (!va || !vb) return 0;
    return cosine(va, vb);
  }

  pairs(minScore: number): { a: string; b: string; score: number }[] {
    const names = [...this.vectors.keys()];
    const out: { a: string; b: string; score: number }[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        let a = names[i] as string;
        let b = names[j] as string;
        if (a > b) [a, b] = [b, a];
        const score = this.similarity(a, b);
        if (score >= minScore) out.push({ a, b, score });
      }
    }
    out.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
    return out;
  }

  private vectorize(tokens: string[]): Map<string, number> {
    const vec = new Map<string, number>();
    for (const [t, count] of termFreq(tokens)) {
      const idf = this.idf.get(t);
      if (idf !== undefined) vec.set(t, count * idf); // unknown words carry no signal
    }
    normalize(vec);
    return vec;
  }
}
