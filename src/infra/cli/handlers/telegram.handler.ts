// ANALIZA: Ten plik obsługuje wiadomości tekstowe z Telegrama
// POTRZEBA: Dodanie obsługi voice messages
// PLAN:
// 1. Sprawdzić czy wiadomość ma voice
// 2. Pobrać plik audio
// 3. Wywołać transkrypcję Whisper
// 4. Przetworzyć transkrypcję jak tekst

// Obecny kod (do rozszerzenia):
// if (message.text) { ... }
// Należy dodać: if (message.voice) { ... }