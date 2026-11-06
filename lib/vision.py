#!/usr/bin/env python3
"""
视觉特征提取 —— 把一张图的「看起来什么样」变成**可复现的数字**。
============================================================================
为什么是这个做法，而不是调个视觉模型：

  规格第四节要「审美特征结构化」（色彩/光线/构图），但规格第六节同时钉了
  两条自我约束：**不得伪造相似度**、**不得把未知评分伪装成概率**。

  如果我们这里"让模型描述一下这张图"，然后写进 recommend 理由 —— 那就是
  把一句编出来的话当成"分析结果"，正好踩在规格禁止的那条线上。

  所以这里的立场是：
    · Pillow 能**量出来**的（亮度、饱和、对比、色温偏向、边缘密度、
      三分法落点），就量，量出来的数字是可复现的、可被自检查的；
    · 量不出来的「好不好看」「有没有空气感」，**不猜** —— 留空，
      由上层如实标注"这一项没做"。

  一句话：**这里产出的是测量值，不是审美判断。**

用法：
  python vision.py <图1> [图2 ...]
成功打印 JSON 一行：
  {"ok":true,"items":[{"path":..., "width":...,"height":..., "aspect":...,
    "brightness":0.62,"contrast":0.18,"saturation":0.41,
    "warmth":0.55,"colorfulness":0.33,
    "dominant":[[r,g,b,share],...],
    "edgeDensity":0.07,"composition":{"ruleOfThirds":0.71,...},
    "tonality":"mid","palette":"pastel","lightness":"bright",
    "orientation":"landscape","features":{...}}]}

单项失败不会让整批失败 —— 那一条进 "error"，其余照常。
"""

import json
import math
import os
import sys


# ── 小工具 ────────────────────────────────────────────────────────────────

def _clamp01(x):
    return 0.0 if x < 0 else (1.0 if x > 1 else float(x))


def _round(x, n=3):
    return round(float(x), n)


def _pixels(im):
    """
    取像素序列。

    ⚠️ Pillow 12 起 `getdata()` 被标了 deprecation（14 移除，
       提示改用 `get_flattened_data`）。但 `get_flattened_data` 在旧版
       Pillow 上**不存在** —— 而插件要能在用户的任意 Pillow 上跑。
       所以这里做兼容层，而不是直接换成新名字（换了就要求 Pillow >= 12）。
       另外把 deprecation 警告压掉：它是打到 stderr 的，
       而我们的协议是「stderr 只写真错误」，混进去会干扰上层判读。
    """
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        getter = getattr(im, "get_flattened_data", None)
        if callable(getter):
            try:
                return list(getter())
            except Exception:  # noqa: BLE001
                pass
        return list(im.getdata())


# ── 主分析 ────────────────────────────────────────────────────────────────

def analyze(path, sample=256):
    from PIL import Image, ImageFilter, ImageStat

    out = {"path": path}

    try:
        im = Image.open(path)
        im.load()
    except Exception as e:  # noqa: BLE001
        out["error"] = "解不开这张图: %s" % e
        return out

    # EXIF 旋转必须认 —— 否则竖图的"构图"分析全是错的
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:  # noqa: BLE001
        pass

    w0, h0 = im.size
    out["width"], out["height"] = int(w0), int(h0)
    out["aspect"] = _round(w0 / float(h0) if h0 else 0.0)

    if h0 and abs(w0 / float(h0) - 1.0) < 0.05:
        out["orientation"] = "square"
    elif w0 > h0:
        out["orientation"] = "landscape"
    else:
        out["orientation"] = "portrait"

    # 统一缩到 sample 长边做统计 —— 原图动辄 8000px，逐像素太慢且无意义
    long0 = max(im.size)
    if long0 > sample:
        sc = sample / float(long0)
        im = im.resize((max(1, int(w0 * sc)), max(1, int(h0 * sc))), Image.LANCZOS)

    # 透明要垫白底，否则 RGB 化时透明区会变黑，把"亮度/色彩"全带偏
    has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    if has_alpha:
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.convert("RGBA").split()[-1])
        rgb = bg
    else:
        rgb = im.convert("RGB")
    out["hasAlpha"] = bool(has_alpha)

    # ── 1) 基础统计 ────────────────────────────────────────────────────
    gray = rgb.convert("L")
    stat = ImageStat.Stat(gray)
    mean_l = stat.mean[0] / 255.0
    std_l = stat.stddev[0] / 255.0

    out["brightness"] = _round(_clamp01(mean_l))
    # 对比度用**标准差**，不是 max-min —— max-min 一张图有个亮点就满值了
    out["contrast"] = _round(_clamp01(std_l * 2.0))

    hsv = rgb.convert("HSV")
    sat_stat = ImageStat.Stat(hsv.split()[1])
    sat_raw = sat_stat.mean[0] / 255.0

    # ⚠️ 这里必须按亮度门控 —— 实测踩到的真 bug：
    #    一张**纯黑**图（5,5,8）PIL 报 saturation=0.373、temperature="cool"。
    #    原因是 HSV 的饱和在 V≈0 时在数学上没有意义（分母趋零），
    #    PIL 仍照报原始通道值，于是一张纯黑图被描述成"中等饱和的冷色调"。
    #    修法：按像素**亮度**给饱和度加权 —— 看不见的像素不该贡献颜色判断。
    try:
        sdat = _pixels(hsv.split()[1])
        ldat = _pixels(gray)
        num = 0.0
        den = 0.0
        tot = 0
        for i in range(0, len(sdat), 3):     # 抽样，够用且快
            w = ldat[i] / 255.0
            num += sdat[i] * w
            den += w
            tot += 1
        sat_gated = (num / den / 255.0) if den > 0 else 0.0
        # ⚠️ 光加权还不够（踩到）：纯黑图 den 虽然极小但**非零**，
        #    相除又把 0.37 还原出来了。必须再按"整体够不够亮"打一次折扣 ——
        #    平均亮度 0.02 的图，它的"色彩"人眼根本看不见。
        mean_lum = (den / tot) if tot else 0.0
        sat_gated *= _clamp01(mean_lum / 0.18)
    except Exception:  # noqa: BLE001
        sat_gated = sat_raw
    out["saturation"] = _round(_clamp01(sat_gated))

    # ── 2) 色温偏向（暖/冷） ───────────────────────────────────────────
    # 用 R 与 B 通道均值之差判定：R 高 = 偏暖，B 高 = 偏冷。
    # ⚠️ 不用"平均色相" —— 色相是环形的，取平均会得到无意义的中间值
    #    （红 350° 和紫 10° 平均成 0° 反而是红）。这是踩过的坑。
    # ⚠️ 同样按亮度门控：纯黑图 (5,5,8) 的 R<B 会让它读成"冷色调"，
    #    但那 3 个灰阶的差别肉眼根本看不见，说"冷"是编的。
    rs, gs, bs = ImageStat.Stat(rgb).mean[:3]
    lum = (0.299 * rs + 0.587 * gs + 0.114 * bs) / 255.0
    tot = rs + gs + bs
    if tot > 0 and lum > 0.06:
        warm_raw = (rs - bs) / tot          # 大致 [-1, 1]
        # 亮度越低，"色温"越不可信 —— 按亮度把偏离往中性拉
        confidence = _clamp01(lum / 0.25)
        warm_raw *= confidence
    else:
        warm_raw = 0.0
    out["warmth"] = _round(_clamp01(0.5 + warm_raw * 1.5))
    out["warmthConfidence"] = _round(_clamp01(lum / 0.25))

    # ── 3) 色彩丰富度（Hasler-Süsstrunk 风格的可复现度量） ──────────────
    # 用 RGB 对立通道的均值/标准差组合，是个成型公式，不是我们自己编的分数。
    import statistics
    px = _pixels(rgb)
    n = len(px) or 1
    rg = [(p[0] - p[1]) for p in px]
    yb = [(0.5 * (p[0] + p[1]) - p[2]) for p in px]
    try:
        rg_m, yb_m = sum(rg) / n, sum(yb) / n
        rg_s = statistics.pstdev(rg)
        yb_s = statistics.pstdev(yb)
        cf = math.sqrt(rg_s ** 2 + yb_s ** 2) + 0.3 * math.sqrt(rg_m ** 2 + yb_m ** 2)
    except Exception:  # noqa: BLE001
        cf = 0.0
    # 归一化到 0..1（经验上限 ~110）
    out["colorfulness"] = _round(_clamp01(cf / 110.0))

    # ── 4) 主色调（量化后取占比最高的几档） ────────────────────────────
    try:
        small = rgb.resize((64, 64), Image.LANCZOS)
        q = small.quantize(colors=6, method=Image.MEDIANCUT).convert("RGB")
        cnt = {}
        for p in _pixels(q):
            # 量化到 16 级，合并相近色
            key = (p[0] // 16 * 16, p[1] // 16 * 16, p[2] // 16 * 16)
            cnt[key] = cnt.get(key, 0) + 1
        total = sum(cnt.values()) or 1
        top = sorted(cnt.items(), key=lambda kv: -kv[1])[:5]
        out["dominant"] = [
            {"rgb": [int(k[0]), int(k[1]), int(k[2])],
             "hex": "#%02x%02x%02x" % (k[0], k[1], k[2]),
             "share": _round(v / float(total))}
            for k, v in top
        ]
    except Exception:  # noqa: BLE001
        out["dominant"] = []

    # ── 5) 边缘密度（≈ 画面有多"满"/线条多不多） ──────────────────────
    #
    # 🔴 这里**不能用 Pillow 的 FIND_EDGES** —— 实测（2026-11-07）踩到：
    #    一张纯灰 250 的图，FIND_EDGES 的输出极值是 (0, 250)，均值 4.85；
    #    裁掉四周边界后不减反增（pad 0→3 时 4.85→5.01）。
    #    原因：PIL 那个 3×3 核的**中心系数是 +1 而非 0**，它整体和不为零，
    #    所以它同时是个高通/锐化算子，对**亮度本身**有响应，不是纯梯度。
    #    拿它当"边缘密度"会把"亮"读成"满"，是彻底的错误信号。
    #
    #    改用**局部均值偏离**：把图降采样成小块，用 3×3 均值滤波得到局部基准，
    #    再算 |像素 − 局部基准| 的均值。这才是真正的梯度量级，
    #    平坦区域（无论明暗）都趋近 0。
    try:
        gw, gh = gray.size
        small = gray.resize((max(8, gw // 2), max(8, gh // 2)), Image.LANCZOS)
        blur = small.filter(ImageFilter.BoxBlur(1.5))   # 局部基准
        sp = _pixels(small)
        bp = _pixels(blur)
        n = min(len(sp), len(bp)) or 1
        acc = 0
        for i in range(n):
            acc += abs(sp[i] - bp[i])
        grad = acc / n / 255.0
        # 归一化：经验上 grad 到 ~0.18 就算很满的画了
        out["edgeDensity"] = _round(_clamp01(grad / 0.18))
        out["edgeGradRaw"] = _round(grad, 4)
    except Exception:  # noqa: BLE001
        out["edgeDensity"] = None
        out["edgeGradRaw"] = None

    # ── 6) 构图：三分法落点 + 重心偏移 ────────────────────────────────
    try:
        gw, gh = gray.size
        small_g = gray
        data = _pixels(small_g)
        # 用"局部与全图均值的偏离"当显著度（比 RGB 距离便宜且够用）
        base = sum(data) / (len(data) or 1)
        sal = [abs(v - base) for v in data]

        def mass(x0, y0, x1, y1):
            s = 0
            for yy in range(y0, min(y1, gh)):
                row = yy * gw
                for xx in range(x0, min(x1, gw)):
                    s += sal[row + xx]
            return s

        total_mass = mass(0, 0, gw, gh) or 1.0
        # 四个三分法交点附近的小方块（各取 1/6 宽高）
        tw, th = gw // 6, gh // 6
        pts = {
            "tl": (gw // 3 - tw // 2, gh // 3 - th // 2),
            "tr": (2 * gw // 3 - tw // 2, gh // 3 - th // 2),
            "bl": (gw // 3 - tw // 2, 2 * gh // 3 - th // 2),
            "br": (2 * gw // 3 - tw // 2, 2 * gh // 3 - th // 2),
        }
        hits = {}
        for name, (px_, py_) in pts.items():
            px_ = max(0, min(gw - tw, px_))
            py_ = max(0, min(gh - th, py_))
            hits[name] = mass(px_, py_, px_ + tw, py_ + th) / total_mass
        out["composition"] = {
            "ruleOfThirds": _round(_clamp01(sum(hits.values()) * 1.6)),
            "thirdsHit": {k: _round(v) for k, v in hits.items()},
            # 重心：亮部质量的水平/垂直中心（0.5 = 居中）
            "centroid": _round(_centroid(sal, gw, gh) or 0.5),
        }
    except Exception:  # noqa: BLE001
        out["composition"] = None

    # ── 7) 分档词（把连续值翻译成人类词，**如实**映射） ────────────────
    out["lightness"] = _bucket(out["brightness"], [(0.22, "dark"), (0.42, "dim"),
                                                   (0.62, "mid"), (0.80, "bright")], "very-bright")
    out["tonality"] = _bucket(out["contrast"], [(0.14, "flat"), (0.28, "soft"),
                                                (0.46, "normal"), (0.64, "strong")], "punchy")
    out["saturationBand"] = _bucket(out["saturation"], [(0.14, "muted"), (0.30, "subtle"),
                                                        (0.50, "moderate"), (0.70, "rich")], "vivid")
    out["temperature"] = _bucket(out["warmth"], [(0.38, "cool"), (0.46, "slightly-cool"),
                                                 (0.54, "neutral"), (0.62, "slightly-warm")], "warm")
    out["palette"] = out.get("colorfulness", 0) >= 0.55 and "colorful" or (
        out["saturation"] <= 0.18 and "near-monochrome" or "restrained")

    return out


def _bucket(v, steps, last):
    if v is None:
        return None
    for limit, name in steps:
        if v < limit:
            return name
    return last


def _centroid(sal, w, h):
    """显著度质量的重心（归一化 0..1）。只算水平方向就够描述"主体偏左/偏右"。"""
    if not w or not h:
        return None
    col = [0] * w
    for y in range(h):
        row = y * w
        for x in range(w):
            col[x] += sal[row + x]
    tot = sum(col) or 1
    acc = 0
    for x in range(w):
        acc += col[x] * (x + 0.5)
    return _clamp01((acc / tot) / w)


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "error": "usage: vision.py <img> [img...]"},
                         ensure_ascii=False))
        return 2

    try:
        import PIL  # noqa: F401
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "Pillow 不可用: %s" % e},
                         ensure_ascii=False))
        return 3

    items = []
    ok_any = False
    for p in args:
        if not os.path.isfile(p):
            items.append({"path": p, "error": "找不到文件"})
            continue
        r = analyze(p)
        if not r.get("error"):
            ok_any = True
        items.append(r)

    print(json.dumps({"ok": True, "analyzed": ok_any, "items": items},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
