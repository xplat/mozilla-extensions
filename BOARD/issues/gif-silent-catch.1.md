GifContent.load() silently swallows autoplay rejections with an empty .catch(), making playback failures invisible; should attach an ErrorContent instead.
