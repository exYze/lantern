// A small emoji list for `:name` suggestions in the message box (common
// shortcodes, as on GitHub and Slack). Kept short on purpose.

const LIST = `smile 😄|grin 😁|joy 😂|rofl 🤣|smiley 😃|slightly_smiling_face 🙂|wink 😉|blush 😊|innocent 😇|heart_eyes 😍|star_struck 🤩|kissing_heart 😘|yum 😋|stuck_out_tongue 😛|zany 🤪|thinking 🤔|shushing 🤫|zipper_mouth 🤐|raised_eyebrow 🤨|neutral_face 😐|expressionless 😑|no_mouth 😶|smirk 😏|unamused 😒|roll_eyes 🙄|grimacing 😬|relieved 😌|pensive 😔|sleepy 😪|sleeping 😴|mask 😷|nerd 🤓|sunglasses 😎|confused 😕|worried 😟|frowning 🙁|open_mouth 😮|hushed 😯|astonished 😲|flushed 😳|pleading 🥺|cry 😢|sob 😭|scream 😱|confounded 😖|persevere 😣|disappointed 😞|sweat 😓|weary 😩|tired_face 😫|yawning 🥱|triumph 😤|rage 😡|angry 😠|skull 💀|poop 💩|clown 🤡|ghost 👻|alien 👽|robot 🤖|wave 👋|raised_hand ✋|ok_hand 👌|pinched 🤌|v ✌️|crossed_fingers 🤞|metal 🤘|call_me 🤙|point_left 👈|point_right 👉|point_up 👆|point_down 👇|thumbsup 👍|+1 👍|thumbsdown 👎|-1 👎|fist 👊|clap 👏|raised_hands 🙌|open_hands 👐|handshake 🤝|pray 🙏|writing_hand ✍️|muscle 💪|eyes 👀|brain 🧠|heart ❤️|orange_heart 🧡|yellow_heart 💛|green_heart 💚|blue_heart 💙|black_heart 🖤|broken_heart 💔|sparkling_heart 💖|100 💯|boom 💥|dizzy 💫|sweat_drops 💦|speech_balloon 💬|thought_balloon 💭|zzz 💤|fire 🔥|sparkles ✨|star ⭐|star2 🌟|zap ⚡|sunny ☀️|cloud ☁️|umbrella ☔|snowflake ❄️|rainbow 🌈|ocean 🌊|earth_americas 🌎|moon 🌙|tada 🎉|confetti_ball 🎊|gift 🎁|balloon 🎈|trophy 🏆|medal 🏅|soccer ⚽|basketball 🏀|football 🏈|dart 🎯|video_game 🎮|game_die 🎲|musical_note 🎵|headphones 🎧|art 🎨|camera 📷|movie_camera 🎥|tv 📺|computer 💻|keyboard ⌨️|desktop 🖥️|iphone 📱|telephone ☎️|battery 🔋|electric_plug 🔌|bulb 💡|flashlight 🔦|candle 🕯️|wrench 🔧|hammer 🔨|hammer_and_wrench 🛠️|gear ⚙️|nut_and_bolt 🔩|link 🔗|lock 🔒|unlock 🔓|key 🔑|shield 🛡️|mag 🔍|bell 🔔|bookmark 🔖|label 🏷️|money_with_wings 💸|moneybag 💰|dollar 💵|credit_card 💳|chart_with_upwards_trend 📈|chart_with_downwards_trend 📉|bar_chart 📊|clipboard 📋|pushpin 📌|paperclip 📎|scissors ✂️|pencil2 ✏️|memo 📝|book 📖|books 📚|notebook 📓|newspaper 📰|calendar 📅|date 📆|card_index 🗂️|file_folder 📁|open_file_folder 📂|wastebasket 🗑️|email 📧|envelope ✉️|inbox_tray 📥|outbox_tray 📤|package 📦|mailbox 📫|hourglass ⌛|stopwatch ⏱️|alarm_clock ⏰|clock3 🕒|rocket 🚀|airplane ✈️|car 🚗|bike 🚲|train 🚆|ship 🚢|house 🏠|office 🏢|hospital 🏥|school 🏫|tent ⛺|mountain ⛰️|coffee ☕|tea 🍵|beer 🍺|wine_glass 🍷|pizza 🍕|hamburger 🍔|taco 🌮|sushi 🍣|apple 🍎|banana 🍌|avocado 🥑|bread 🍞|cake 🍰|cookie 🍪|dog 🐶|cat 🐱|mouse 🐭|fox 🦊|bear 🐻|panda 🐼|koala 🐨|tiger 🐯|lion 🦁|cow 🐮|pig 🐷|frog 🐸|monkey 🐵|chicken 🐔|penguin 🐧|owl 🦉|bee 🐝|bug 🐛|butterfly 🦋|snail 🐌|turtle 🐢|snake 🐍|octopus 🐙|whale 🐳|dolphin 🐬|fish 🐟|crab 🦀|seedling 🌱|evergreen_tree 🌲|cactus 🌵|herb 🌿|four_leaf_clover 🍀|maple_leaf 🍁|rose 🌹|sunflower 🌻|tulip 🌷|white_check_mark ✅|heavy_check_mark ✔️|x ❌|warning ⚠️|no_entry ⛔|question ❓|exclamation ❗|bangbang ‼️|arrow_right ➡️|arrow_left ⬅️|arrow_up ⬆️|arrow_down ⬇️|arrows_counterclockwise 🔄|repeat 🔁|new 🆕|free 🆓|sos 🆘|red_circle 🔴|green_circle 🟢|yellow_circle 🟡|blue_circle 🔵|white_circle ⚪|black_circle ⚫|lantern 🏮|flag_us 🇺🇸|checkered_flag 🏁|triangular_flag 🚩|pirate_flag 🏴‍☠️`;

export const EMOJI: [name: string, char: string][] = LIST.split("|").map((pair) => {
  const i = pair.indexOf(" ");
  return [pair.slice(0, i), pair.slice(i + 1)];
});

/** Emoji whose name starts with (then contains) what you typed. */
export function suggestEmoji(query: string, max = 6): [string, string][] {
  const q = query.toLowerCase();
  const starts = EMOJI.filter(([n]) => n.startsWith(q));
  const contains = EMOJI.filter(([n]) => !n.startsWith(q) && n.includes(q));
  return [...starts, ...contains].slice(0, max);
}

export const emojiByName = (name: string) => EMOJI.find(([n]) => n === name.toLowerCase())?.[1];
