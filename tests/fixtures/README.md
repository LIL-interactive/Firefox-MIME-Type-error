Крошечные (1 с, 160×120) тестовые файлы, сделаны ffmpeg из `testsrc` + `sine`:

| файл | команда (кратко) |
|---|---|
| h264_faststart.mp4 | `-c:v libx264 -profile:v high -c:a aac -movflags +faststart` |
| h264_hi10_moov_end.mp4 | `-c:v libx264 -profile:v high10 -pix_fmt yuv420p10le -c:a aac` (moov в конце) |
| hevc.mp4 | `-c:v libx265 -tag:v hvc1 -c:a aac -movflags +faststart` |
| hevc.mkv | `-c:v libx265 -c:a aac` |
| vp9.webm | `-c:v libvpx-vp9 -c:a libopus` |
| h264.mov | `-c:v libx264 -c:a aac -f mov` |
