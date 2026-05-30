import json
import re
import sys


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(1)


def main() -> None:
    try:
        import ctranslate2
        from argostranslate import package
    except Exception as error:
        fail(f"Argos Translate is not available: {error}\nRun: pip install argostranslate")

    installed_packages = package.get_installed_packages()
    translator_cache = {}

    def split_text(text: str) -> list[str]:
        pieces = []
        for paragraph in re.split(r"(\n+)", text):
            if not paragraph:
                continue
            if paragraph.isspace():
                pieces.append(paragraph)
                continue
            pieces.extend(
                part
                for part in re.split(r"(?<=[.!?。！？])\s+", paragraph)
                if part
            )
        return pieces

    def get_package(source_language: str, target_language: str):
        for item in installed_packages:
            if item.from_code == source_language and item.to_code == target_language:
                return item
        available = ", ".join(f"{item.from_code}->{item.to_code}" for item in installed_packages) or "none"
        raise RuntimeError(
            f"Missing Argos language package: {source_language} -> {target_language}.\n"
            f"Installed packages: {available}.\n"
            "Install the matching Argos Translate language package."
        )

    def translate_request(request):
        text = str(request.get("text") or "")
        source_language = str(request.get("sourceLanguage") or "en")
        target_language = str(request.get("targetLanguage") or "zh")
        if not text.strip():
            raise RuntimeError("No text to translate.")
        if source_language == target_language:
            return text

        cache_key = (source_language, target_language)
        cached = translator_cache.get(cache_key)
        if cached is None:
            argos_package = get_package(source_language, target_language)
            translator = ctranslate2.Translator(
                str(argos_package.package_path / "model"),
                device="cpu",
                inter_threads=1,
                intra_threads=0,
                compute_type="auto",
            )
            cached = (argos_package, translator)
            translator_cache[cache_key] = cached

        argos_package, translator = cached
        pieces = split_text(text)
        translated_pieces = []
        batch = []
        batch_indexes = []

        for index, piece in enumerate(pieces):
            if piece.isspace():
                translated_pieces.append(piece)
                continue
            translated_pieces.append("")
            batch.append(argos_package.tokenizer.encode(piece.strip()))
            batch_indexes.append(index)

        if batch:
            target_prefix = None
            if argos_package.target_prefix:
                target_prefix = [[argos_package.target_prefix]] * len(batch)

            translated_batches = translator.translate_batch(
                batch,
                target_prefix=target_prefix,
                replace_unknowns=True,
                max_batch_size=32,
                batch_type="tokens",
                beam_size=4,
            )

            for index, translated_batch in zip(batch_indexes, translated_batches):
                value = argos_package.tokenizer.decode(translated_batch.hypotheses[0])
                if argos_package.target_prefix and value.startswith(argos_package.target_prefix):
                    value = value[len(argos_package.target_prefix) :]
                translated_pieces[index] = value.strip()

        separator = "" if target_language.startswith("zh") else " "
        return separator.join(translated_pieces).strip()

    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = translate_request(request)
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
