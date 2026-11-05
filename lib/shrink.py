#!/usr/bin/env python3
"""
图片缩放 —— 给 QQ 发图用。
pixiv 原图动辄 8-24MB（实测一张 23.9MB 的 PNG），直接发 QQ 会被拒或者慢到没法用。

用法：
  python shrink.py <输入图> <输出图> [长边上限] [JPEG质量]
成功打印 JSON 一行：{"ok":true,"out":...,"bytes":...,"width":...,"height":...}
失败非 0 退出，stderr 写原因。

⚠️ 为什么不让 Node 干：运行时里没有 sharp（只在 app.asar 里，shell 和 require 都进不去），
   而 Python 侧的 Pillow 是现成的。这一层只做"缩"，不做别的。
"""
import json
import os
import sys


def main():
    if len(sys.argv) < 3:
        print("usage: shrink.py <in> <out> [longEdge] [quality]", file=sys.stderr)
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    long_edge = int(sys.argv[3]) if len(sys.argv) > 3 else 1600
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 88

    try:
        from PIL import Image
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "Pillow 不可用: %s" % e}, ensure_ascii=False))
        return 3

    if not os.path.isfile(src):
        print(json.dumps({"ok": False, "error": "找不到输入图: %s" % src}, ensure_ascii=False))
        return 4

    try:
        im = Image.open(src)
        im.load()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "解不开这张图: %s" % e}, ensure_ascii=False))
        return 5

    w0, h0 = im.size
    # EXIF 旋转要认，否则竖图发出去是躺着的
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:  # noqa: BLE001
        pass

    long0 = max(im.size)
    scale = (long_edge / long0) if long0 > long_edge else 1.0
    if scale < 1.0:
        nw, nh = max(1, int(im.size[0] * scale)), max(1, int(im.size[1] * scale))
        im = im.resize((nw, nh), Image.LANCZOS)

    # 透明要垫白底，否则存 JPEG 会变黑块；有透明就存 PNG
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)

    if has_alpha:
        # 先试 PNG，压不动再退 JPEG（垫白）
        im.convert("RGBA").save(dst, "PNG", optimize=True)
        out_bytes = os.path.getsize(dst)
        target = 1_800_000
        if out_bytes > target:
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.convert("RGBA").split()[-1])
            dst = os.path.splitext(dst)[0] + ".jpg"
            bg.save(dst, "JPEG", quality=quality, optimize=True, progressive=True)
            im = bg
    else:
        im.convert("RGB").save(dst, "JPEG", quality=quality, optimize=True, progressive=True)

    out_bytes = os.path.getsize(dst)
    print(
        json.dumps(
            {
                "ok": True,
                "out": dst,
                "bytes": out_bytes,
                "width": im.size[0],
                "height": im.size[1],
                "from": [int(w0), int(h0)],
                "scaled": bool(scale < 1.0),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
