// Pretty titles from filenames: "Movie.Name.2019.1080p.mkv" -> "Movie Name (2019)".

export interface ParsedTitle {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
}

const JUNK_RE =
  /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|web|hdtv|dvdrip|dvd|remux|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac|ac3|eac3|dts|truehd|atmos|10bit|8bit|proper|repack|extended|unrated|imax|multi|subbed|dubbed)\b/i;
const EP_RE = /\b[sS](\d{1,2})[ ._-]?[eE](\d{1,3})\b|\b(\d{1,2})x(\d{2,3})\b/;
const YEAR_RE = /(?:^|[\s([])((?:19|20)\d{2})(?=$|[\s)\]])/g;

function tidy(s: string): string {
  return s
    .replace(/[[(][^\])]*$/, '') // dangling bracket group
    .replace(/[\s\-–:[(]+$/, '')
    .replace(/^[\s\-–:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseTitle(filename: string): ParsedTitle {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  // Dots and underscores are word separators unless the name already uses spaces.
  let s = stem.includes(' ') ? stem.replace(/_/g, ' ') : stem.replace(/[._]/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, (m) => (/\b(19|20)\d{2}\b/.test(m) ? m : ' ')); // drop [group] tags

  const ep = EP_RE.exec(s);
  if (ep) {
    const season = Number(ep[1] ?? ep[3]);
    const episode = Number(ep[2] ?? ep[4]);
    const show = tidy(s.slice(0, ep.index).replace(YEAR_RE, ' '));
    const pad = (n: number): string => String(n).padStart(2, '0');
    const code = `S${pad(season)}E${pad(episode)}`;
    return { title: show ? `${show} ${code}` : code, season, episode };
  }

  // The year is the last plausible year that is not the very first word ("2001 A Space Odyssey 1968").
  let year: number | undefined;
  let cut = s.length;
  for (const m of s.matchAll(YEAR_RE)) {
    const at = m.index + m[0].indexOf(m[1]!);
    if (at === 0) continue;
    year = Number(m[1]);
    cut = at;
  }
  const junk = JUNK_RE.exec(s);
  if (junk && junk.index > 0 && junk.index < cut) cut = junk.index;
  const title = tidy(s.slice(0, cut)) || tidy(stem);
  return year ? { title: `${title} (${year})`, year } : { title };
}
