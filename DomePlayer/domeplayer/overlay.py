"""On-screen text (stats / messages) drawn with Pillow into a texture.

Text is drawn by us, not by mpv's OSD, so it stays readable once the video
image is warped for the dome in later phases.
"""
from __future__ import annotations

import moderngl
from PIL import Image, ImageDraw, ImageFont

_FONT_CANDIDATES = [
    "consola.ttf",         # Windows: Consolas
    "cour.ttf",            # Windows: Courier New
    "DejaVuSansMono.ttf",  # Linux
    "Menlo.ttc",           # macOS
]

VERT = """
#version 330
uniform vec4 u_rect;   // x0, y0, x1, y1 in NDC
in vec2 in_pos;        // 0..1
out vec2 v_uv;
void main() {
    v_uv = vec2(in_pos.x, 1.0 - in_pos.y);   // Pillow images are top-down
    gl_Position = vec4(mix(u_rect.xy, u_rect.zw, in_pos), 0.0, 1.0);
}
"""

FRAG = """
#version 330
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 f_color;
void main() { f_color = texture(u_tex, v_uv); }
"""


def load_font(size: int):
    for name in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


class TextOverlay:
    def __init__(self, ctx: moderngl.Context, font_size: int):
        self.ctx = ctx
        self.font = load_font(font_size)
        self.pad = max(6, font_size // 2)
        self.prog = ctx.program(vertex_shader=VERT, fragment_shader=FRAG)
        quad = ctx.buffer(_quad_bytes())
        self.vao = ctx.vertex_array(self.prog, [(quad, "2f", "in_pos")])
        self.tex: moderngl.Texture | None = None
        self.size = (0, 0)
        self._text = None

    def set_text(self, text: str, color=(235, 235, 235)) -> None:
        key = (text, color)
        if key == self._text:
            return
        self._text = key
        if not text:
            return
        probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        box = probe.multiline_textbbox((0, 0), text, font=self.font, spacing=4)
        w = box[2] + 2 * self.pad
        h = box[3] + 2 * self.pad
        img = Image.new("RGBA", (w, h), (0, 0, 0, 170))
        ImageDraw.Draw(img).multiline_text((self.pad, self.pad), text, font=self.font,
                                           fill=color + (255,), spacing=4)
        self._upload(img)

    def set_image(self, img: Image.Image) -> None:
        """Use a ready-made RGBA image instead of text (e.g. corner markers)."""
        self._text = ("<image>", id(img))
        self._upload(img.convert("RGBA"))

    def _upload(self, img: Image.Image) -> None:
        w, h = img.size
        if self.tex is None or self.tex.size != (w, h):
            if self.tex is not None:
                self.tex.release()
            self.tex = self.ctx.texture((w, h), 4)
            self.tex.filter = (moderngl.NEAREST, moderngl.NEAREST)
        self.tex.write(img.tobytes())
        self.size = (w, h)

    def draw(self, screen_w: int, screen_h: int, x: int = 16, y: int = 16, center: bool = False) -> None:
        if not self._text or not self._text[0] or self.tex is None:
            return
        w, h = self.size
        if center:
            x = (screen_w - w) // 2
            y = (screen_h - h) // 2
        x0 = x / screen_w * 2 - 1
        x1 = (x + w) / screen_w * 2 - 1
        y1 = 1 - y / screen_h * 2
        y0 = 1 - (y + h) / screen_h * 2
        self.prog["u_rect"].value = (x0, y0, x1, y1)
        self.tex.use(0)
        self.prog["u_tex"].value = 0
        self.ctx.enable(moderngl.BLEND)
        self.ctx.blend_func = moderngl.SRC_ALPHA, moderngl.ONE_MINUS_SRC_ALPHA
        self.vao.render(moderngl.TRIANGLE_STRIP)
        self.ctx.disable(moderngl.BLEND)


def _quad_bytes() -> bytes:
    import struct
    return struct.pack("8f", 0, 0, 1, 0, 0, 1, 1, 1)
