// Демо-сценарий: позволяет проверить интерфейс и логику без API-ключа.
// Загружается только как контент-скрипт рядом с content.js.

window.__CI_DEMO__ = {
  gap: 5200,
  lines: [
    {
      id: 1,
      en: "Okay, Dmitry — before we go into details, can you walk me through what you actually shipped last quarter?",
      ru: 'Хорошо, Дмитрий. Прежде чем углубляться, расскажите, что вы реально выпустили в прошлом квартале?',
      answer:
        "Sure. Last quarter we shipped an agent pipeline for support: it reads incoming tickets, drafts replies and routes anything sensitive to a human. First-response time went from about four hours to under ten minutes.",
      answerRu:
        'Конечно. В прошлом квартале мы выпустили агентный пайплайн для поддержки: он читает тикеты, готовит черновики ответов, а чувствительные темы передаёт человеку. Первое время ответа упало с четырёх часов до десяти минут.',
    },
    {
      id: 2,
      en: 'And who owns the evaluation side? I mean, how do you know the answers are actually getting better?',
      ru: 'А кто отвечает за оценку качества? То есть откуда вы знаете, что ответы действительно становятся лучше?',
      answer:
        "That sits with me. We keep a gold set of about six hundred real tickets, score every release against it, and watch the failure modes in production. If a change doesn't move the numbers, it doesn't ship.",
      answerRu:
        'Это на мне. У нас есть эталонная выборка примерно из шестисот реальных тикетов, каждый релиз прогоняется по ней, плюс следим за ошибками в проде. Если изменение не двигает метрики — оно не выходит.',
    },
    {
      id: 3,
      en: "That sounds reasonable. What would you need from our side to get a pilot running by January?",
      ru: 'Звучит разумно. Что вам нужно с нашей стороны, чтобы запустить пилот к январю?',
      answer:
        "Three things: read access to a sample of your tickets, one person on your side who knows the support process, and a two-week window for the first evaluation. We can run the pilot in parallel with your current workflow.",
      answerRu:
        'Три вещи: доступ на чтение к выборке ваших тикетов, один человек с вашей стороны, который знает процесс поддержки, и две недели на первую оценку. Пилот можем вести параллельно с текущим процессом.',
    },
    {
      id: 4,
      en: 'Got it. And roughly what does this cost for a team of twenty engineers?',
      ru: 'Понятно. И примерно сколько это стоит для команды из двадцати инженеров?',
      answer:
        "Let me put the exact numbers together and send them over today — I don't want to guess in front of you. Roughly, it scales with seats and volume, and the pilot itself is fixed-price.",
      answerRu:
        'Давайте я соберу точные цифры и пришлю сегодня — не хочу называть числа наугад. Примерно: цена зависит от числа мест и объёма, а сам пилот стоит фиксированно.',
    },
    {
      id: 5,
      en: "Fair enough. Honestly, this looks closer to what we need than the two vendors we spoke to. Can you send a short summary?",
      ru: 'Справедливо. Честно говоря, это ближе к тому, что нам нужно, чем два вендора, с которыми мы говорили. Пришлёте короткое резюме?',
      answer:
        "Absolutely — I'll send a one-page summary with the pilot scope, timeline and pricing today, and I'll copy your colleague. Thanks for the time, it was a good conversation.",
      answerRu:
        'Обязательно. Сегодня пришлю одностраничное резюме: объём пилота, сроки и цены, и скопирую вашего коллегу. Спасибо за время, хороший разговор.',
    },
  ],
};
