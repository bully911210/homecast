// Pretty titles from filenames: "Movie.Name.2019.1080p.mkv" -> "Movie Name (2019)".

export interface ParsedTitle {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  resolution?: string;
  hdr?: string;
  videoCodec?: string;
  audioCodec?: string;
  channels?: string;
  tags?: string[];
}

const JUNK_RE =
  /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|dv|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|web|hdtv|dvdrip|dvd|remux|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac|ac3|eac3|dts|truehd|atmos|10bit|8bit|proper|repack|extended|unrated|imax|multi|subbed|dubbed)\b/i;
const EP_RE = /\b[sS](\d{1,2})[ ._-]?[eE](\d{1,3})(?:\s*-\s*[eE]?(\d{1,3})|\s*[eE](\d{1,3}))?\b|\b(\d{1,2})x(\d{2,3})\b/;
const YEAR_RE = /(?:^|[\s([])((?:19|20)\d{2})(?=$|[\s)\]])/g;
const RESOLUTION_RE = /\b(2160p|1080[pi]|720p|576p|480p|4k|uhd)\b/i;
const HDR_RE = /\b(dolby[ ._-]?vision|hdr10\+?|hdr)\b/i;
const VIDEO_CODEC_RE = /\b(x264|x265|h\.?264|h\.?265|hevc|avc|av1)\b/i;
const AUDIO_CODEC_RE = /\b(ddp|eac3|ac3|dts(?:-hd)?|truehd|aac|mp3|opus|flac)(?=\b|\d)/i;
const CHANNELS_RE = /(?:\b|(?<=ddp))(7\.1|5\.1|2\.0)\b/i;
const TAG_RE = /\b(web-?dl|webrip|bluray|blu-ray|brrip|bdrip|hdtv|remux|proper|repack|extended|unrated|imax|atmos|multi|subbed|dubbed)\b/gi;

function releaseMeta(s: string): Pick<ParsedTitle, 'resolution' | 'hdr' | 'videoCodec' | 'audioCodec' | 'channels' | 'tags'> {
  const resolution = RESOLUTION_RE.exec(s)?.[1]?.toLowerCase();
  const rawHdr = HDR_RE.exec(s)?.[1]?.toLowerCase().replace(/[ ._-]/g, '');
  const hdr = rawHdr === 'dolbyvision' ? 'Dolby Vision' : rawHdr?.toUpperCase();
  const rawVideo = VIDEO_CODEC_RE.exec(s)?.[1]?.toLowerCase().replace(/[.]/g, '');
  const videoCodec = rawVideo === 'x264' || rawVideo === 'avc' ? 'h264' : rawVideo === 'x265' || rawVideo === 'h265' ? 'hevc' : rawVideo;
  const rawAudio = AUDIO_CODEC_RE.exec(s)?.[1]?.toLowerCase();
  const audioCodec = rawAudio === 'ddp' ? 'eac3' : rawAudio;
  const channels = CHANNELS_RE.exec(s)?.[1];
  const tags = [...new Set([...s.matchAll(TAG_RE)].map((m) => m[1]!.toLowerCase().replace('blu-ray', 'bluray').replace('webdl', 'web-dl')))];
  return {
    ...(resolution ? { resolution } : {}),
    ...(hdr ? { hdr } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(audioCodec ? { audioCodec } : {}),
    ...(channels ? { channels } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

function tidy(s: string): string {
  return s
    .replace(/[[(][^\])]*$/, '') // dangling bracket group
    .replace(/[\s\-–:[(]+$/, '')
    .replace(/^[\s\-–:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseTitle(filename: string): ParsedTitle {
  const stem = filename.replace(/\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|mts|wmv|flv|mpg|mpeg|ogv|3gp|mp3|flac|m4a|aac|ogg|oga|opus|wav|wma)$/i, '');
  const normalizedMeta = stem.replace(/(7|5|2)\.([01])\b/g, '$1~DOT~$2').replace(/[._]/g, ' ').replace(/~DOT~/g, '.');
  const metadata = releaseMeta(normalizedMeta);
  // Dots and underscores are word separators unless the name already uses spaces.
  let s = stem.includes(' ') ? stem.replace(/_/g, ' ') : stem.replace(/[._]/g, ' ');
  s = s.replace(/\[[^\]]*\]/g, (m) => (/\b(19|20)\d{2}\b/.test(m) ? m : ' ')); // drop [group] tags

  const ep = EP_RE.exec(s);
  if (ep) {
    const season = Number(ep[1] ?? ep[5]);
    const episode = Number(ep[2] ?? ep[6]);
    const episodeEnd = ep[3] ?? ep[4] ? Number(ep[3] ?? ep[4]) : undefined;
    const show = tidy(s.slice(0, ep.index).replace(YEAR_RE, ' '));
    const pad = (n: number): string => String(n).padStart(2, '0');
    const code = `S${pad(season)}E${pad(episode)}`;
    return { title: show ? `${show} ${code}` : code, season, episode, ...(episodeEnd ? { episodeEnd } : {}), ...metadata };
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
  return year ? { title: `${title} (${year})`, year, ...metadata } : { title, ...metadata };
}
