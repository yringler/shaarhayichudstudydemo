/**
 * The bottom audio bar. A listen link (`a.listen[data-source][data-t]`) loads that
 * class into the single <audio>, seeks to the second and plays. Without JS the link
 * still opens the mp3 at `#t=`.
 */
import { formatTime } from '../lib/format';

interface PlayerSource {
  title: string;
  url: string;
  duration: number;
}

const bar = document.getElementById('player');
const audio = bar?.querySelector('audio');
const dataEl = document.getElementById('player-sources');

if (bar && audio && dataEl) {
  const sources = JSON.parse(dataEl.textContent || '{}') as Record<string, PlayerSource>;
  const el = <T extends Element>(name: string): T => {
    const found = bar.querySelector<T>(`[data-el="${name}"]`);
    if (!found) throw new Error(`player: missing ${name}`);
    return found;
  };
  const titleEl = el<HTMLElement>('title');
  const timeEl = el<HTMLElement>('time');
  const seekEl = el<HTMLInputElement>('seek');
  const toggleBtn = bar.querySelector<HTMLButtonElement>('[data-act="toggle"]');
  let currentKey: string | null = null;
  let seeking = false;
  let activeLink: HTMLAnchorElement | null = null;

  const duration = (): number => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return currentKey ? (sources[currentKey]?.duration ?? 0) : 0;
  };

  const render = (): void => {
    const d = duration();
    timeEl.textContent = d ? `${formatTime(audio.currentTime)} / ${formatTime(d)}` : formatTime(audio.currentTime);
    if (!seeking) {
      seekEl.max = String(Math.max(1, Math.floor(d)));
      seekEl.value = String(Math.floor(audio.currentTime));
    }
    const playing = !audio.paused && !audio.ended;
    bar.classList.toggle('is-playing', playing);
    toggleBtn?.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };

  const show = (): void => {
    if (bar.hidden) {
      bar.hidden = false;
      document.body.classList.add('has-player');
    }
  };

  const markActive = (link: HTMLAnchorElement | null): void => {
    activeLink?.classList.remove('is-active');
    activeLink = link;
    activeLink?.classList.add('is-active');
  };

  const playAt = (key: string, seconds: number, link: HTMLAnchorElement | null): void => {
    const source = sources[key];
    if (!source) return;
    show();
    if (currentKey !== key) {
      currentKey = key;
      audio.src = source.url;
      titleEl.textContent = source.title;
      bar.dataset['source'] = key;
    }
    const seek = (): void => {
      audio.currentTime = seconds;
    };
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
    else {
      // Before metadata the browser may ignore the position; set it now and again once known.
      try {
        seek();
      } catch {
        /* not seekable yet */
      }
      audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    markActive(link);
    void audio.play().catch(() => render());
    render();
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>('a.listen[data-source]');
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    playAt(link.dataset['source'] ?? '', Number(link.dataset['t'] ?? 0), link);
  });

  bar.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const act = target.closest<HTMLElement>('[data-act]')?.dataset['act'];
    switch (act) {
      case 'toggle':
        if (audio.paused) void audio.play().catch(() => render());
        else audio.pause();
        break;
      case 'back':
        audio.currentTime = Math.max(0, audio.currentTime - 15);
        break;
      case 'fwd':
        audio.currentTime = Math.min(duration() || Infinity, audio.currentTime + 15);
        break;
      case 'close':
        audio.pause();
        bar.hidden = true;
        document.body.classList.remove('has-player');
        markActive(null);
        break;
      default:
        return;
    }
    render();
  });

  seekEl.addEventListener('input', () => {
    seeking = true;
    timeEl.textContent = `${formatTime(Number(seekEl.value))} / ${formatTime(duration())}`;
  });
  seekEl.addEventListener('change', () => {
    seeking = false;
    audio.currentTime = Number(seekEl.value);
    render();
  });

  for (const type of ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'seeked']) {
    audio.addEventListener(type, render);
  }

  document.addEventListener('keydown', (event) => {
    if (bar.hidden || event.key !== ' ' || event.target !== document.body) return;
    event.preventDefault();
    if (audio.paused) void audio.play().catch(() => render());
    else audio.pause();
  });
}
