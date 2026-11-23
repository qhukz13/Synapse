export function youtubeEmbed(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    return;
  const host = url.hostname.toLowerCase();
  const short = host === "youtu.be";
  if (
    !short &&
    !["www.youtube.com", "m.youtube.com", "youtube.com"].includes(host)
  )
    return;
  if (!short && !["/watch", "/playlist"].includes(url.pathname)) return;
  const video = short ? url.pathname.slice(1) : url.searchParams.get("v");
  const playlist = url.searchParams.get("list");
  if (video && !/^[\w-]{11}$/.test(video)) return;
  if (playlist && !/^[\w-]+$/.test(playlist)) return;
  if (!video && !playlist) return;
  const embed = new URL(
    "https://www.youtube-nocookie.com/embed/" + (video || "videoseries"),
  );
  if (playlist) embed.searchParams.set("list", playlist);
  const time = url.searchParams.get("t") ?? url.searchParams.get("start");
  if (time) {
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(time);
    if (parts) {
      const seconds =
        Number(parts[1] ?? 0) * 3600 +
        Number(parts[2] ?? 0) * 60 +
        Number(parts[3] ?? 0);
      if (Number.isSafeInteger(seconds) && seconds > 0)
        embed.searchParams.set("start", String(seconds));
    }
  }
  return embed.href;
}
