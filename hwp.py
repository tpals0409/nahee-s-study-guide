"""HWP5 문서의 본문 문단을 뽑는다(표준 라이브러리만). 글상자·표 안의 글도 순서대로 나오고, 수식은 [수식: ...] 로 남긴다."""
import struct, zlib


def _streams(data):
    ss = 1 << struct.unpack_from("<H", data, 30)[0]
    dir_start = struct.unpack_from("<I", data, 48)[0]
    difat = [x for x in struct.unpack_from("<109I", data, 76) if x < 0xFFFFFFFA]  # ponytail: 7MB 넘는 파일은 DIFAT 체인 필요
    fat = []
    for s in difat:
        fat += struct.unpack_from(f"<{ss // 4}I", data, (s + 1) * ss)

    def chain(s):
        while s < 0xFFFFFFFA:
            yield data[(s + 1) * ss:(s + 2) * ss]
            s = fat[s]

    d = b"".join(chain(dir_start))
    entries = {}
    for i in range(0, len(d), 128):
        n = struct.unpack_from("<H", d, i + 64)[0]
        if n:
            entries[d[i:i + n - 2].decode("utf-16-le")] = struct.unpack_from("<I", d, i + 116)[0], struct.unpack_from("<Q", d, i + 120)[0]
    mini = b"".join(chain(entries["Root Entry"][0]))
    minifat_raw = b"".join(chain(struct.unpack_from("<I", data, 60)[0]))
    minifat = struct.unpack(f"<{len(minifat_raw) // 4}I", minifat_raw)

    def read(name):
        start, size = entries[name]
        if size >= struct.unpack_from("<I", data, 56)[0]:
            return b"".join(chain(start))[:size]
        out, s = [], start  # 작은 스트림은 64바이트 단위 미니 스트림에 있다
        while s < 0xFFFFFFFA:
            out.append(mini[s * 64:(s + 1) * 64])
            s = minifat[s]
        return b"".join(out)[:size]

    return list(entries), read


def _para_text(b):
    out, i = [], 0
    while i + 1 < len(b):
        c = struct.unpack_from("<H", b, i)[0]
        if c < 32:
            if c in (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23):
                i += 16  # 인라인/확장 제어문자는 8글자 폭
                continue
            if c == 10 or c == 13:
                out.append("\n")
        else:
            out.append(chr(c))
        i += 2
    return "".join(out)


def paragraphs(path):
    data = open(path, "rb").read()
    names, read = _streams(data)
    compressed = read("FileHeader")[36] & 1
    paras = []
    for name in sorted(n for n in names if n.startswith("Section")):
        body = read(name)
        if compressed:
            body = zlib.decompress(body, -15)
        i = 0
        while i + 4 <= len(body):
            h = struct.unpack_from("<I", body, i)[0]
            tag, n = h & 0x3FF, h >> 20
            i += 4
            if n == 0xFFF:
                n = struct.unpack_from("<I", body, i)[0]
                i += 4
            rec = body[i:i + n]
            i += n
            if tag == 67:
                t = _para_text(rec).strip()
                if t:
                    paras.append(t)
            elif tag == 88:  # EQEDIT
                m = struct.unpack_from("<H", rec, 4)[0]
                paras.append("[수식: " + rec[6:6 + 2 * m].decode("utf-16-le", "replace") + "]")
    return paras


if __name__ == "__main__":
    import sys
    print("\n".join(paragraphs(sys.argv[1])))
