# TODO

- Revisit Ideogram 4 LoRA support. The model itself appears to support LoRAs,
  and upstream stable-diffusion.cpp documents general LoRA support alongside
  Ideogram 4 support. Our current UI blocks LoRAs for the `ideogram4` bundle
  because LoRA tags are appended to the prompt, while Ideogram 4 uses a
  structured JSON prompt; appending `<lora:name:strength>` after the JSON object
  would corrupt the prompt. Before enabling this, test `sd-cli` directly and
  decide where to inject LoRA tags safely, likely inside a JSON string field such
  as `high_level_description` or `style_description`.
