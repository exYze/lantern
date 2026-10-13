// Shows a shared Lantern bot template. The template is in the URL after "#":
// "z" + base64url(deflate-raw(JSON)) or "j" + base64url(JSON). Everything from
// it goes into the page as text, never as HTML.
(function () {
  "use strict";

  var TOOLS = {
    files: "Files in its workspace",
    shell: "Terminal commands",
    web: "Web search and reading pages",
    memory: "Memories",
    routines: "Routines",
    skills: "Skills",
    conversationSearch: "Searching past chats",
    subagents: "Subagents",
    bots: "Asking your other bots",
    browser: "Its own browser",
    email: "Its own inbox",
    forms: "Forms in the chat",
    planning: "Plans and goals",
    pages: "Pages, files and slides",
    profile: "Changing its own look",
  };
  var DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

  function $(id) {
    return document.getElementById(id);
  }

  function fromB64url(s) {
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function inflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }

  function schedule(s) {
    if (!s) return "";
    if (s.kind === "daily") return "every day at " + s.time;
    if (s.kind === "weekdays") return "weekdays at " + s.time;
    if (s.kind === "weekly") return (s.days || []).map(function (d) { return DAYS[d]; }).join(", ") + " at " + s.time;
    if (s.kind === "interval") return "every " + s.minutes + " minutes";
    return "once";
  }

  function item(list, text) {
    var li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
  }

  function fail(message) {
    $("name").textContent = "This link doesn't hold a template";
    $("error").textContent = message;
    $("error").hidden = false;
  }

  function show(t) {
    document.title = t.name + ": a Lantern bot";
    $("name").textContent = t.name;
    $("tagline").textContent = t.tagline || "";
    $("instructions").textContent = t.instructions;
    var mark = $("mark");
    var color = /^#[0-9a-f]{6}$/i.test((t.avatar && t.avatar.color) || "") ? t.avatar.color : "#c9cec7";
    mark.style.background = color;
    mark.textContent = (t.avatar && t.avatar.badge) || "";
    var tools = $("tools");
    Object.keys(TOOLS).forEach(function (k) {
      // Every tool is on unless the template turns it off.
      if (!t.tools || t.tools[k] !== false) item(tools, TOOLS[k]);
    });
    if (t.skills && t.skills.length) {
      $("skills-box").hidden = false;
      t.skills.forEach(function (s) { item($("skills"), s.name + (s.description ? ": " + s.description : "")); });
    }
    if (t.routines && t.routines.length) {
      $("routines-box").hidden = false;
      t.routines.forEach(function (r) { item($("routines"), r.name + ", " + schedule(r.schedule)); });
    }
    $("details").hidden = false;
  }

  // A different link pasted into the same tab only changes the hash.
  window.addEventListener("hashchange", function () {
    location.reload();
  });

  var data = location.hash.slice(1);
  if (!data) return fail("Ask the person who shared it to send the whole link, including everything after the #.");
  var read;
  try {
    if (data[0] === "z") {
      if (typeof DecompressionStream === "undefined") return fail("This browser is too old to read the link. Open it in a current browser, or paste it into Lantern directly.");
      read = inflate(fromB64url(data.slice(1)));
    } else if (data[0] === "j") {
      read = Promise.resolve(new TextDecoder().decode(fromB64url(data.slice(1))));
    } else {
      return fail("The link is incomplete or damaged.");
    }
  } catch (e) {
    return fail("The link is incomplete or damaged.");
  }
  read
    .then(function (json) {
      var t = JSON.parse(json);
      if (!t || t.v !== 1 || typeof t.name !== "string" || typeof t.instructions !== "string") throw new Error("bad template");
      show(t);
    })
    .catch(function () {
      fail("The link is incomplete or damaged.");
    });

  $("copy").addEventListener("click", function () {
    navigator.clipboard.writeText(location.href).then(function () {
      $("copied").hidden = false;
    });
  });
})();
