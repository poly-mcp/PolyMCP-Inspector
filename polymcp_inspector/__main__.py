import argparse
import asyncio
import secrets

from .server import run_inspector


def main() -> None:
    parser = argparse.ArgumentParser(description="PolyMCP Inspector (standalone)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=6274)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--secure", action="store_true")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--allow-origin", action="append", default=[])
    parser.add_argument("--rate-limit", type=int, default=120)
    parser.add_argument("--rate-window", type=int, default=60)
    args = parser.parse_args()

    api_key = args.api_key
    if args.secure and not api_key:
        api_key = secrets.token_urlsafe(24)
        print(f"[polymcp-inspector] Generated API key: {api_key}")

    asyncio.run(
        run_inspector(
            host=args.host,
            port=args.port,
            verbose=args.verbose,
            open_browser=not args.no_browser,
            secure_mode=args.secure,
            api_key=api_key,
            allowed_origins=args.allow_origin or None,
            rate_limit_per_minute=args.rate_limit,
            rate_limit_window_seconds=args.rate_window,
        )
    )


if __name__ == "__main__":
    main()
