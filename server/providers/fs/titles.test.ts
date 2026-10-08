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
  ])('%s', (name, want) => expect(parseTitle(name)).toMatchObject(want));

  it.each([
    ['Movie.Name.2026.1080p.WEB-DL.x264-GROUP.mkv', { title: 'Movie Name (2026)', year: 2026, resolution: '1080p', videoCodec: 'h264', tags: ['web-dl'] }],
    ['Movie_Name_2025_2160p_HDR10_HEVC.mkv', { title: 'Movie Name (2025)', resolution: '2160p', hdr: 'HDR10', videoCodec: 'hevc' }],
    ['The.Office.US.S03E17.720p.x264.mkv', { title: 'The Office US S03E17', season: 3, episode: 17, resolution: '720p', videoCodec: 'h264' }],
    ['Silo.S02E04.2160p.WEB-DL.DDP5.1.Atmos.H265.mkv', { title: 'Silo S02E04', season: 2, episode: 4, resolution: '2160p', audioCodec: 'eac3', channels: '5.1', videoCodec: 'hevc' }],
    ['Some.Movie.2024.1080p.BluRay.DTS.x265-GROUP.mkv', { title: 'Some Movie (2024)', audioCodec: 'dts', videoCodec: 'hevc', tags: ['bluray'] }],
    ['Movie', { title: 'Movie' }],
    ['Movie (2024)', { title: 'Movie (2024)', year: 2024 }],
    ['Movie.2024', { title: 'Movie (2024)', year: 2024 }],
    ['Movie_2024', { title: 'Movie (2024)', year: 2024 }],
    ['Movie.2024.1080p', { title: 'Movie (2024)', year: 2024, resolution: '1080p' }],
    ['Movie.2024.2160p.HDR', { title: 'Movie (2024)', resolution: '2160p', hdr: 'HDR' }],
    ['Movie.2024.WEB-DL', { title: 'Movie (2024)', tags: ['web-dl'] }],
    ['Movie.2024.BluRay.x265', { title: 'Movie (2024)', videoCodec: 'hevc' }],
    ['Show.S01E01', { title: 'Show S01E01', season: 1, episode: 1 }],
    ['Show.S01E10', { title: 'Show S01E10', season: 1, episode: 10 }],
    ['Show.1x01', { title: 'Show S01E01', season: 1, episode: 1 }],
    ['Show - S01E01', { title: 'Show S01E01', season: 1, episode: 1 }],
    ['Show.S01E01-E02', { title: 'Show S01E01', season: 1, episode: 1, episodeEnd: 2 }],
    ['Show.S01E01E02', { title: 'Show S01E01', season: 1, episode: 1, episodeEnd: 2 }],
    ['Blade Runner 2049 (2017)', { title: 'Blade Runner 2049 (2017)', year: 2017 }],
    ['[Group] Show - 05 [1080p].mkv', { title: 'Show - 05', resolution: '1080p' }],
  ])('understands %s', (name, want) => expect(parseTitle(name)).toMatchObject(want));
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
