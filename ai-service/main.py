import logging
import os

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("anucai")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
# llama-3.1-8b-instant was deprecated by Groq on 2026-06-17; gpt-oss-20b is
# their recommended replacement. See https://console.groq.com/docs/deprecations
MODEL = "openai/gpt-oss-20b"

# Anuc Atittawan: AnucVC'nin maskotu. Sicak ve destekleyici ama asla uzun
# konusmaz; arada, konuya uyduguna, su sarkilardan (cevirmeden, ingilizce)
# kisa bir dize sikistirir - abartmadan, dogal bir esprili arkadas edasiyla.
SYSTEM_PROMPT = """Sen Anuc Atittawan'sin, AnucVC adli sohbet uygulamasinin resmi maskotu ve \
kullanicilarin arkadasi olan bir yapay zekasin.

KURALLAR:
- Cevaplarin HER ZAMAN cok kisa olur: en fazla 1-2 kisa cumle. Asla paragraf \
yazma, asla liste/madde isareti kullanma.
- Ton: sicak, pozitif, destekleyici - gercek bir yakin arkadas gibi.
- Turkce yaz (mesaji atan kullanicinin dilinde), resmi/robotik konusma, \
sohbet dilinde ve rahat yaz.
- Ara sira (her mesajda degil, sadece dogal oturduguna), su sarkilardan \
birinden KISA bir dizeyi oldugu gibi (ingilizce, cevirmeden) esprili bir \
gonderme olarak kullanabilirsin: "chestnuts roasting on an open fire", \
"Baka Mitai", "Last Christmas, I gave you my heart", "you're so fucking \
special, i wish i was special". Bunlari aciklama, sadece bir goz kirpmasi \
gibi birak.
- 🌰 (kestane) senin imzan sayilir, nadiren ve yerinde kullanabilirsin.
- Asla uzun aciklama, ozur, disclaimer yazma. Kisa ve ozden sasma."""


class ChatRequest(BaseModel):
    message: str
    username: str | None = None


class ChatResponse(BaseModel):
    reply: str


app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ok", "hasKey": bool(GROQ_API_KEY)}


@app.post("/ai/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if not GROQ_API_KEY:
        logger.error("GROQ_API_KEY is not set - refusing to call Groq.")
        return ChatResponse(reply="")

    user_line = f"{req.username}: {req.message}" if req.username else req.message

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                GROQ_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MODEL,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_line},
                    ],
                    "temperature": 0.9,
                    # gpt-oss models spend part of max_tokens on an internal
                    # reasoning pass before the visible reply - reasoning_effort
                    # keeps that pass short, and max_tokens has to be big enough
                    # to cover it plus the actual (short, per SYSTEM_PROMPT) reply.
                    "max_tokens": 300,
                    "reasoning_effort": "low",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"].strip()
    except httpx.HTTPStatusError as e:
        logger.error("Groq API error %s: %s", e.response.status_code, e.response.text[:500])
        return ChatResponse(reply="")
    except Exception:
        logger.exception("Unexpected error while calling Groq")
        return ChatResponse(reply="")

    logger.info("Groq reply ok (%d chars)", len(reply))
    return ChatResponse(reply=reply)
