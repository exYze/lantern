// Fills the download links from the latest GitHub release and answers the demo approval tag.
(function () {
  var REPO = "exYze/lantern";
  var ua = navigator.userAgent;
  var os = /Android/i.test(ua) ? "android" : /iPhone|iPad/i.test(ua) ? "ios" : /Mac/i.test(ua) ? "macos" : /Win/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "";
  var names = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android" };

  var mine = document.querySelector('.row[data-os="' + os + '"]');
  if (mine) {
    mine.classList.add("mine");
    var here = document.createElement("span");
    here.className = "stamp";
    here.textContent = "This device";
    mine.querySelector("h3").appendChild(here);
  }

  fetch("https://api.github.com/repos/" + REPO + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then(function (r) {
      return r.ok ? r.json() : Promise.reject(r.status);
    })
    .then(function (rel) {
      var assets = rel.assets || [];
      document.querySelectorAll("a.file").forEach(function (a) {
        var hit = assets.find(function (x) {
          return x.name.indexOf(a.getAttribute("data-match")) !== -1 && !/\.sig$/.test(x.name);
        });
        if (!hit) return;
        a.href = hit.browser_download_url;
        var size = document.createElement("span");
        size.textContent = (hit.size / 1048576).toFixed(1) + " MB";
        a.appendChild(size);
      });
      var line = document.getElementById("release-line");
      var date = (rel.published_at || "").slice(0, 10);
      line.textContent = "Version " + rel.tag_name.replace(/^v/, "") + (date ? ", released " + date + "." : ".") + " The release lists a SHA-256 checksum for every file in SHA256SUMS.";
      var hero = document.getElementById("hero-download");
      var main = mine && mine.querySelector("a.file");
      if (main && names[os]) {
        hero.href = main.href;
        hero.textContent = "Download for " + names[os];
      }
    })
    .catch(function () {
      /* The links already point at the releases page. */
    });

  var tag = document.getElementById("demo-tag");
  var stamp = document.getElementById("demo-stamp");
  tag.querySelectorAll("button").forEach(function (b) {
    b.addEventListener("click", function () {
      stamp.textContent = b.getAttribute("data-answer");
      stamp.hidden = false;
      tag.classList.add("answered");
      tag.classList.toggle("denied", b.getAttribute("data-answer") === "Denied");
    });
  });
})();
