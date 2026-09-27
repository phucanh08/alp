process.on("message", (message) => {
  if (message?.type !== "alp_frame") return;
  process.send?.(message);
});
