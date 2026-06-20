"""Native file picker via tkinter. ~Verbatim from LLama-GUI (generic)."""

from ..context import AppContext

# purpose -> (filetypes, title) for the native dialog.
PURPOSE_FILTERS: dict[str, tuple[list[tuple[str, str]], str]] = {
    # SD model components support several weight formats.
    "diffusion_model": (
        [("Model", "*.safetensors *.ckpt *.gguf *.sft *.bin *.pth")],
        "Select diffusion model",
    ),
    "model": ([("Model", "*.safetensors *.ckpt *.gguf *.sft *.bin *.pth")], "Select model"),
    "vae": ([("VAE", "*.safetensors *.ckpt *.gguf *.sft *.bin")], "Select VAE"),
    "clip_l": ([("CLIP", "*.safetensors *.gguf *.bin")], "Select CLIP-L"),
    "clip_g": ([("CLIP", "*.safetensors *.gguf *.bin")], "Select CLIP-G"),
    "t5xxl": ([("T5", "*.safetensors *.gguf *.bin")], "Select T5XXL"),
    "llm": ([("LLM encoder", "*.safetensors *.gguf *.bin")], "Select LLM text encoder"),
    "taesd": ([("TAESD", "*.safetensors *.gguf *.bin")], "Select TAESD"),
    "esrgan": ([("ESRGAN", "*.pth *.safetensors")], "Select ESRGAN upscaler"),
    "control": ([("ControlNet", "*.pth *.safetensors")], "Select ControlNet"),
    "lora": ([("LoRA", "*.safetensors *.gguf *.bin")], "Select LoRA"),
    "image": ([("Image", "*.png *.jpg *.jpeg *.webp *.bmp")], "Select image"),
}


def select_file(ctx: AppContext, purpose: str, title: str | None = None) -> dict:
    # TODO(Phase 1): tkinter.filedialog.askopenfilename with PURPOSE_FILTERS,
    # initial dir = ctx.paths.models for model purposes.
    raise NotImplementedError
