import { describe, expect, it } from 'vitest';
import { parseTitle } from './titles.ts';
import { matchSidecar } from './scan.ts';

describe('parseTitle', () => {
  it.each([
    ['Movie.Name.2019.1080p.mkv', { title: 'Movie Name (2019)', year: 2019 }],
    ['The.Matrix.1999.REMASTERED.2160p.UHD.BluRay.x265.mkv', { title: 'The Matrix (1999)', year: 1999 }],
    ['2001.A.Space.Odyssey.1968.mkv', { title: '2001 A Space Odyssey (1968)', year: 1968 }],
    ['Blade Runner 2049 (2017).mp4', { title: 'Blade Runner 2049 (2017)', year: 2017 }],
    ['Movie Name (2019) [1080p].mkv', { title: 'Movie Name (2019)', year: 2019 }],
    ['[Group] Some_Anime_Movie_2016_BDRip.mkv', { title: 'Some Anime Movie (2016)', year: 2016 }],
    ['home video.mp4', { title: 'home video' }],
    ['Holiday.720p.mp4', { title: 'Holiday' }],
    ['1917.mkv', { title: '1917' }],
    ['Show.Name.S01E02.720p.mkv', { title: 'Show Name S01E02', season: 1, episode: 2 }],
    ['show.name.s1e5.mkv', { title: 'show name S01E05', season: 1, episode: 5 }],
    ['Show Name - 2x07 - Title.avi', { title: 'Show Name S02E07', season: 2, episode: 7 }],
    ['Doctor.Who.2005.S03E10.Blink.mkv', { title: 'Doctor Who S03E10', season: 3, episode: 10 }],
    ['Ünïcödé Fïlm mit Leerzeichen (2017).mkv', { title: 'Ünïcödé Fïlm mit Leerzeichen (2017)', year: 2017 }],
  ])('%s', (name, want) => expect(parseTitle(name)).toEqual(want));
});

describe('sidecar subtitles', () => {
  it.each([
    ['Movie.mkv', 'Movie.srt', { file: 'Movie.srt', lang: undefined, forced: false }],
    ['Movie.mkv', 'Movie.en.srt', { file: 'Movie.en.srt', lang: 'en', forced: false }],
    ['Movie.mkv', 'movie.eng.forced.vtt', { file: 'movie.eng.forced.vtt', lang: 'eng', forced: true }],
    ['Movie.mkv', 'Movie.2.srt', { file: 'Movie.2.srt', lang: undefined, forced: false }],
    ['Movie.mkv', 'Other.srt', null],
    ['Movie.mkv', 'Movie.nfo', null],
  ])('%s + %s', (video, sub, want) => expect(matchSidecar(video, sub)).toEqual(want));
});
