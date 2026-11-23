export function resourceInfo(address: string) {
  const url = new URL(address);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const on = (...names: string[]) =>
    names.some((n) => host === n || host.endsWith("." + n));
  const yt = on("youtube.com", "youtu.be");
  const videoId = yt
    ? on("youtu.be")
      ? url.pathname.slice(1)
      : url.searchParams.get("v")
    : null;
  const listId = yt ? url.searchParams.get("list") : null;
  const t = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "0";
  const duration = /^(?:(\d+)h)?(?:(\d+)m)?(\d+)s?$/.exec(t);
  const start = duration
    ? Number(duration[1] ?? 0) * 3600 +
      Number(duration[2] ?? 0) * 60 +
      Number(duration[3])
    : 0;
  let kind = "article";
  if (yt)
    kind = listId
      ? videoId
        ? "youtube-video-in-playlist"
        : "youtube-playlist"
      : "youtube-video";
  else if (
    on("arxiv.org", "royalsocietypublishing.org") ||
    host.startsWith("papers.")
  )
    kind = "paper";
  else if (/\.pdf$/i.test(url.pathname)) kind = "pdf";
  else if (on("github.com")) kind = "repository";
  else if (
    on(
      "coursera.org",
      "deeplearning.ai",
      "khanacademy.org",
      "ocw.mit.edu",
      "cs50.harvard.edu",
      "fullstackdeeplearning.com",
      "stanford.edu",
    ) ||
    (on("kaggle.com") && url.pathname.startsWith("/learn"))
  )
    kind = "course";
  else if (
    on(
      "scikit-learn.org",
      "python.org",
      "pytorch.org",
      "mlflow.org",
      "developers.google.com",
    ) ||
    (on("huggingface.co") && url.pathname.includes("/docs"))
  )
    kind = "docs";
  else if (
    on(
      "oreilly.com",
      "manning.com",
      "springer.com",
      "mitpress.mit.edu",
      "goodreads.com",
      "d2l.ai",
      "deeplearningbook.org",
      "themlbook.com",
      "mml-book.github.io",
    )
  )
    kind = "book";
  else if (on("kaggle.com", "deep-ml.com", "pythontutor.com"))
    kind = "practice";
  return { kind, videoId, listId, start, insecure: url.protocol === "http:" };
}
