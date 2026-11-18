import base64
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
expected = {}


def out(name):
    return os.path.join(here, name)


def record(name, rgba_image):
    rgba = rgba_image.convert("RGBA")
    expected[name] = {
        "width": rgba.width,
        "height": rgba.height,
        "rgba": base64.b64encode(rgba.tobytes()).decode("ascii"),
    }


def noisy(width, height):
    image = Image.new("RGB", (width, height))
    image.putdata(
        [((x * 37 + y * 11) % 256, (x * 17 + y * 53) % 256, (x * 7 + y * 29 + 90) % 256) for y in range(height) for x in range(width)]
    )
    return image


def smooth(width, height):
    image = Image.new("RGB", (width, height))
    image.putdata(
        [
            (x * 255 // (width - 1), y * 255 // (height - 1), (x + y) * 255 // (width + height - 2))
            for y in range(height)
            for x in range(width)
        ]
    )
    return image


def save(name, image, **options):
    image.save(out(name), **options)
    record(name, Image.open(out(name)))


rgb = noisy(13, 9)
alpha = Image.new("RGBA", (13, 9))
alpha.putdata([(r, g, b, (x * 20 + y * 5) % 256) for (x, y), (r, g, b) in zip(((x, y) for y in range(9) for x in range(13)), rgb.getdata())])
gray = rgb.convert("L")
graya = Image.merge("LA", (gray, alpha.getchannel("A")))
palette = rgb.quantize(16)
bilevel = gray.point(lambda v: 255 if v > 127 else 0).convert("1")

save("png-rgb8.png", rgb)
save("png-rgba8.png", alpha)
save("png-gray8.png", gray)
save("png-graya8.png", graya)
save("png-palette8.png", rgb.quantize(200), optimize=False)
save("png-palette4.png", palette, bits=4)
palette2 = rgb.quantize(4)
save("png-palette2.png", palette2, bits=2)
save("png-palette1.png", rgb.quantize(2), bits=1)
save("png-bilevel.png", bilevel)
transparent_palette = rgb.quantize(8)
save("png-palette-trns.png", transparent_palette, transparency=bytes([0, 128, 255]))
save("png-gray-trns.png", gray.point(lambda v: v // 16 * 16), transparency=64)
save("png-rgb-trns.png", Image.new("RGB", (6, 4), (10, 20, 30)), transparency=(10, 20, 30))

save("bmp-rgb24.bmp", rgb)
save("bmp-rgb8.bmp", rgb.quantize(64))
save("bmp-gray8.bmp", gray)
save("bmp-bilevel.bmp", bilevel)
save("bmp-rgba32.bmp", alpha)

gif_frame = rgb.quantize(32)
save("gif-interlaced.gif", gif_frame)
save("gif-plain.gif", gif_frame, interlace=False)
save("gif-transparent.gif", gif_frame, transparency=3, interlace=False)
save("gif-animated.gif", gif_frame, save_all=True, append_images=[rgb.quantize(8)], duration=100, loop=0, interlace=False)

save("pnm-p6.ppm", rgb)
save("pnm-p5.pgm", gray)
save("pnm-p4.pbm", bilevel)

with tempfile.TemporaryDirectory() as temp:
    source = os.path.join(temp, "source.ppm")
    smooth(17, 11).save(source)
    gray_source = os.path.join(temp, "gray.pgm")
    smooth(17, 11).convert("L").save(gray_source)

    def jpeg(name, source_path, *flags):
        target = out(name)
        subprocess.run(["cjpeg", *flags, "-outfile", target, source_path], check=True)
        reference = os.path.join(temp, name + ".ppm")
        subprocess.run(["djpeg", "-nosmooth", "-dct", "float", "-outfile", reference, target], check=True)
        record(name, Image.open(reference))

    jpeg("jpeg-444.jpg", source, "-sample", "1x1", "-quality", "90")
    jpeg("jpeg-420.jpg", source, "-sample", "2x2", "-quality", "90")
    jpeg("jpeg-422.jpg", source, "-sample", "2x1", "-quality", "90")
    jpeg("jpeg-440.jpg", source, "-sample", "1x2", "-quality", "90")
    jpeg("jpeg-gray.jpg", gray_source, "-grayscale", "-quality", "90")
    jpeg("jpeg-restart.jpg", source, "-sample", "2x2", "-restart", "1B", "-quality", "90")
    jpeg("jpeg-optimized.jpg", source, "-optimize", "-quality", "75")
    jpeg("jpeg-q1-wide.jpg", source, "-sample", "1x1", "-quality", "1")
    script = os.path.join(temp, "scans.txt")
    with open(script, "w") as handle:
        handle.write("0: 0 63 0 0;\n1: 0 63 0 0;\n2: 0 63 0 0;\n")
    jpeg("jpeg-multiscan.jpg", source, "-sample", "2x2", "-scans", script, "-quality", "90")
    subprocess.run(["cjpeg", "-progressive", "-outfile", out("jpeg-progressive.jpg"), source], check=True)
    subprocess.run(["cjpeg", "-arithmetic", "-outfile", out("jpeg-arithmetic.jpg"), source], check=True)
    subprocess.run(["cjpeg", "-precision", "12", "-outfile", out("jpeg-12bit.jpg"), source], check=True)
    subprocess.run(["cjpeg", "-precision", "8", "-lossless", "1", "-outfile", out("jpeg-lossless.jpg"), source], check=True)
    subprocess.run(["sips", "-s", "format", "bmp", out("png-rgb8.png"), "--out", out("bmp-sips.bmp")], check=True, capture_output=True)
    record("bmp-sips.bmp", Image.open(out("bmp-sips.bmp")))

with open(out("expected.json"), "w") as handle:
    json.dump(expected, handle, indent=1, sort_keys=True)
