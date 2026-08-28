'use strict';
/*
 * Min Bogreol - MCP-server (Model Context Protocol).
 *
 * Streamable HTTP + JSON-RPC 2.0, haandskrevet. MCP ER bare JSON-RPC over HTTP,
 * saa der er ingen grund til en pakke - og dermed ingen forsyningskaede at holde patchet.
 *
 * Godkendelse er de SAMME adgangsnoegler som resten af API'et, med samme scopes:
 * "read" kan laese, "full" kan ogsaa skrive. Alle boeger gaar gennem serverens
 * sanitizeBook + upsert - praecis den vej webappen bruger. Der findes ingen saerlig
 * MCP-vej ind i dataene.
 *
 * Modulet kender hverken databasen eller http'en - serverens funktioner sproejtes
 * ind gennem `srv` (samme moenster som oauth.js), saa det kan testes for sig.
 */

const PROTOKOL = '2025-06-18';
const PROTOKOLLER = ['2025-06-18', '2025-03-26', '2024-11-05'];

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9æøå]/g, '');
const normIsbn = s => { const d = String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase(); return d.length === 10 || d.length === 13 ? d : ''; };
const firstNames = a => { const p = String(a || '').trim().split(/\s+/); return p.length > 1 ? p.slice(0, -1).join(' ').toLowerCase() : ''; };
const lastName = a => { const p = String(a || '').trim().split(/\s+/); return p.length ? p[p.length - 1].toLowerCase() : ''; };

function opret(srv) {
  const alive = userId => srv.booksFor(userId);

  function beskriv(b) {
    const flag = [];
    if (b.owned) flag.push('owned ' + (b.format || 'paperback'));
    if (b.read) flag.push('read' + (b.readYear ? ' ' + b.readYear : ''));
    if (b.reading && !b.read) flag.push('reading now');
    if (b.owned && !b.read && !b.reading) flag.push('unread');
    if (b.wishlist) flag.push('wishlist');
    if (b.loaned) flag.push('loaned' + (b.loanedTo ? ' to ' + b.loanedTo : '') + (b.loanedAt ? ' since ' + String(b.loanedAt).slice(0, 10) : ''));
    if (b.rating) flag.push(b.rating + '/5');
    return `- ${b.title}${(b.authors || []).length ? ' – ' + b.authors.join(', ') : ''}`
      + (b.series ? ` (${b.series}${b.seriesNo ? ' #' + b.seriesNo : ''})` : '')
      + (flag.length ? ` [${flag.join(', ')}]` : '') + `  id: ${b.id}`;
  }
  const kort = b => ({
    id: b.id, title: b.title, authors: b.authors || [], isbn: b.isbn || '', series: b.series || '', series_no: b.seriesNo || '',
    edition: b.edition || '', printing: b.printing || '',
    owned: !!b.owned, format: b.owned ? (b.format || 'paperback') : null, read: !!b.read, read_year: b.readYear || null,
    reading: !!b.reading && !b.read, wishlist: !!b.wishlist, loaned: !!b.loaned, loaned_to: b.loanedTo || '', loaned_at: b.loanedAt || null,
    rating: b.rating || 0, notes: b.notes || '', has_cover: !!(b.cover || b.coverVer), added_at: b.addedAt, updated_at: b.updatedAt
  });

  /* find en bog paa id, ISBN eller titel - modellen skal ikke gaette id'er */
  function findBog(userId, noegle) {
    const s = String(noegle || '').trim();
    if (!s) return null;
    const alle = alive(userId);
    const isbn = normIsbn(s);
    return alle.find(b => b.id === s)
      || (isbn && alle.find(b => normIsbn(b.isbn) === isbn))
      || alle.find(b => norm(b.title) === norm(s))
      || null;
  }
  const ukendtBog = n => ({ fejl: `No book matching "${n}". Use search_books or list_books to find the id first.` });

  const FILTRE = {
    all: () => true,
    owned: b => b.owned,
    not_owned: b => !b.owned,
    read: b => b.read,
    reading: b => b.reading && !b.read,
    unread: b => b.owned && !b.read && !b.reading,
    read_not_owned: b => b.read && !b.owned,
    wishlist: b => b.wishlist,
    loaned: b => b.loaned,
    hardback: b => b.owned && b.format === 'hardback',
    paperback: b => b.owned && b.format === 'paperback'
  };
  const SORT = {
    // efternavn, derefter fornavn, derefter titel - som i appen
    // efternavn -> fornavn -> serie i laeserraekkefoelge -> titel (som i appen)
    author: (a, b) => (lastName((a.authors || [])[0]) || 'øøø').localeCompare(lastName((b.authors || [])[0]) || 'øøø', 'da')
      || firstNames((a.authors || [])[0]).localeCompare(firstNames((b.authors || [])[0]), 'da')
      || (a.series || a.title).localeCompare(b.series || b.title, 'da')
      || (parseFloat(a.seriesNo) || 999) - (parseFloat(b.seriesNo) || 999)
      || a.title.localeCompare(b.title, 'da'),
    title: (a, b) => a.title.localeCompare(b.title, 'da'),
    added: (a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title, 'da'),
    series: (a, b) => (a.series || 'øøøøø').localeCompare(b.series || 'øøøøø', 'da') || (parseFloat(a.seriesNo) || 999) - (parseFloat(b.seriesNo) || 999)
  };
  const liste = (rows, tekstHvisTom) => rows.length
    ? { tekst: rows.map(beskriv).join('\n') + `\n\n${rows.length} book(s).`, data: { books: rows.map(kort) } }
    : { tekst: tekstHvisTom, data: { books: [] } };

  const BOGFELTER = {
    title: { type: 'string' },
    authors: { type: 'array', items: { type: 'string' }, description: 'Full names, e.g. ["Jussi Adler-Olsen"].' },
    isbn: { type: 'string', description: 'ISBN-10 or ISBN-13, digits only or with hyphens.' },
    series: { type: 'string' },
    series_no: { type: 'string', description: 'Number in the series, e.g. "3".' },
    edition: { type: 'string', description: 'e.g. "1. udgave"' },
    printing: { type: 'string', description: 'e.g. "4. oplag"' },
    owned: { type: 'boolean', description: 'The user owns a copy.' },
    format: { type: 'string', enum: ['hardback', 'paperback'], description: 'Binding of the owned copy.' },
    read: { type: 'boolean' },
    reading: { type: 'boolean', description: 'Currently reading it (only meaningful when read is false).' },
    read_year: { type: 'integer', description: 'Year the book was read.' },
    wishlist: { type: 'boolean' },
    loaned: { type: 'boolean', description: 'The copy is currently lent out.' },
    loaned_to: { type: 'string', description: 'Who has borrowed it.' },
    loaned_at: { type: 'string', description: 'YYYY-MM-DD the loan started.' },
    rating: { type: 'integer', minimum: 0, maximum: 5 },
    notes: { type: 'string' },
    cover_url: { type: 'string', description: 'https URL of a cover image.' }
  };
  /* Oversaet vaerktoejs-argumenter (snake_case) til bogens felter (camelCase). Kun
   * felter der er sendt med, saettes - saa update_book kan patche. */
  function felterFra(a) {
    const p = {};
    const map = { title: 'title', authors: 'authors', isbn: 'isbn', series: 'series', series_no: 'seriesNo', edition: 'edition',
      printing: 'printing', owned: 'owned', format: 'format', read: 'read', read_year: 'readYear', wishlist: 'wishlist',
      loaned: 'loaned', loaned_to: 'loanedTo', loaned_at: 'loanedAt', rating: 'rating', notes: 'notes', cover_url: 'cover',
      reading: 'reading' };
    for (const [k, f] of Object.entries(map)) if (a[k] !== undefined && a[k] !== null) p[f] = a[k];
    if (p.authors && !Array.isArray(p.authors)) p.authors = String(p.authors).split(',').map(s => s.trim()).filter(Boolean);
    if (p.readYear !== undefined) p.readYear = parseInt(p.readYear, 10) || null;
    if (p.rating !== undefined) p.rating = Math.max(0, Math.min(5, parseInt(p.rating, 10) || 0));
    if (p.isbn !== undefined) p.isbn = normIsbn(p.isbn) || String(p.isbn || '');
    if (p.cover !== undefined && !/^https:\/\//.test(p.cover)) delete p.cover;
    if (p.loanedAt !== undefined && p.loanedAt && !/^\d{4}-\d{2}-\d{2}/.test(String(p.loanedAt))) return { fejl: 'loaned_at must be YYYY-MM-DD.' };
    if (p.loaned === true && !p.loanedAt) p.loanedAt = new Date().toISOString().slice(0, 10);
    if (p.loaned === false) { p.loanedTo = ''; p.loanedAt = null; }
    if (p.read === true) { p.reading = false; if (p.readYear === undefined) p.readYear = new Date().getFullYear(); }
    if (p.read === false) p.readYear = null;
    return { p };
  }

  /* ---------------------------------------------------------- vaerktoejer */

  const VAERKTOEJER = [
    {
      name: 'search_books',
      scope: 'read',
      description: 'Search the user\'s own library by title, author, series or ISBN (substring match). '
        + 'Returns matching books with their ids.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for.' },
          limit: { type: 'integer', description: 'Max results (default 25).' }
        },
        required: ['query']
      },
      kald(a, auth) {
        const qn = norm(a.query), qi = String(a.query || '').replace(/[^0-9Xx]/g, '');
        if (!qn && !qi) return { fejl: 'query must not be empty.' };
        const rows = alive(auth.user.id).filter(b =>
          (qn && (norm(b.title).includes(qn) || norm((b.authors || []).join(' ')).includes(qn) || norm(b.series).includes(qn)))
          || (qi.length >= 4 && String(b.isbn || '').replace(/[^0-9Xx]/g, '').includes(qi))
        ).sort(SORT.author).slice(0, a.limit || 25);
        return liste(rows, `No books match "${a.query}".`);
      }
    },
    {
      name: 'list_books',
      scope: 'read',
      description: 'List books in the user\'s library with an optional filter (owned, read, unread, wishlist, loaned, '
        + 'hardback, paperback, not_owned, read_not_owned) and optional author/series narrowing.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: Object.keys(FILTRE), description: 'Default "all".' },
          author: { type: 'string', description: 'Only books by this author (substring).' },
          series: { type: 'string', description: 'Only books in this series (substring).' },
          sort: { type: 'string', enum: Object.keys(SORT), description: 'Default "author".' },
          limit: { type: 'integer', description: 'Max rows (default 50).' },
          offset: { type: 'integer', description: 'Skip this many rows (for paging).' }
        }
      },
      kald(a, auth) {
        const f = FILTRE[a.filter || 'all'];
        if (!f) return { fejl: `Unknown filter "${a.filter}". Known: ${Object.keys(FILTRE).join(', ')}` };
        let rows = alive(auth.user.id).filter(f);
        if (a.author) rows = rows.filter(b => norm((b.authors || []).join(' ')).includes(norm(a.author)));
        if (a.series) rows = rows.filter(b => norm(b.series).includes(norm(a.series)));
        const total = rows.length;
        rows = rows.sort(SORT[a.sort] || SORT.author).slice(a.offset || 0, (a.offset || 0) + (a.limit || 50));
        const r = liste(rows, 'No books match that filter.');
        if (total > rows.length) r.tekst += ` (showing ${rows.length} of ${total} - use offset/limit for more)`;
        r.data.total = total;
        return r;
      }
    },
    {
      name: 'get_book',
      scope: 'read',
      description: 'Get one book with all details, by id, ISBN or exact title.',
      inputSchema: { type: 'object', properties: { book: { type: 'string', description: 'id, ISBN or exact title' } }, required: ['book'] },
      kald(a, auth) {
        const b = findBog(auth.user.id, a.book);
        if (!b) return ukendtBog(a.book);
        const k = kort(b);
        const linjer = Object.entries(k).filter(([, v]) => v !== '' && v !== null && v !== false && v !== 0)
          .map(([kk, v]) => `${kk}: ${Array.isArray(v) ? v.join(', ') : v}`);
        return { tekst: linjer.join('\n'), data: { book: k } };
      }
    },
    {
      name: 'library_stats',
      scope: 'read',
      description: 'Statistics for the library: totals, books read per year, most read authors, formats, series.',
      inputSchema: { type: 'object', properties: {} },
      kald(a, auth) {
        const rows = alive(auth.user.id);
        const byYear = {}, byAuthor = {}, byFmt = {}, bySeries = {};
        rows.forEach(b => {
          if (b.read && b.readYear) byYear[b.readYear] = (byYear[b.readYear] || 0) + 1;
          if (b.read) (b.authors || []).forEach(x => byAuthor[x] = (byAuthor[x] || 0) + 1);
          if (b.owned) byFmt[b.format || 'paperback'] = (byFmt[b.format || 'paperback'] || 0) + 1;
          if (b.series) bySeries[b.series] = (bySeries[b.series] || 0) + 1;
        });
        const top = o => Object.entries(o).sort((x, y) => y[1] - x[1]);
        const stats = {
          total: rows.length, owned: rows.filter(b => b.owned).length, read: rows.filter(b => b.read).length,
          unread_owned: rows.filter(b => b.owned && !b.read).length, wishlist: rows.filter(b => b.wishlist).length,
          loaned: rows.filter(b => b.loaned).length,
          read_per_year: Object.fromEntries(Object.entries(byYear).sort()), formats: byFmt,
          top_authors: top(byAuthor).slice(0, 10).map(([name, n]) => ({ name, read: n })),
          top_series: top(bySeries).slice(0, 10).map(([name, n]) => ({ name, books: n }))
        };
        return {
          tekst: `${stats.total} books: ${stats.owned} owned, ${stats.read} read, ${stats.unread_owned} unread (owned), `
            + `${stats.wishlist} on wishlist, ${stats.loaned} lent out.\n`
            + `Read per year: ${Object.entries(stats.read_per_year).map(([y, n]) => `${y}: ${n}`).join(', ') || '—'}\n`
            + `Formats: ${Object.entries(byFmt).map(([f, n]) => `${f} ${n}`).join(', ') || '—'}\n`
            + `Most read authors: ${stats.top_authors.map(x => `${x.name} (${x.read})`).join(', ') || '—'}`,
          data: stats
        };
      }
    },
    {
      name: 'add_book',
      scope: 'full',
      description: 'Add a book to the library. Checks for duplicates (same ISBN or same title + first author) and refuses '
        + 'unless allow_duplicate is true. If an ISBN is given and title/authors/cover are missing, they are looked up '
        + 'in bibliotek.dk automatically.',
      inputSchema: {
        type: 'object',
        properties: Object.assign({}, BOGFELTER, {
          allow_duplicate: { type: 'boolean', description: 'Add even if a similar book exists.' }
        }),
        required: []
      },
      async kald(a, auth) {
        const f = felterFra(a);
        if (f.fejl) return f;
        const p = f.p;
        if (p.isbn && (!p.title || !(p.authors || []).length || !p.cover)) {
          try {
            const d = await srv.lookupIsbn(normIsbn(p.isbn));
            if (d && d.found) {
              if (!p.title && d.title) p.title = d.title;
              if (!(p.authors || []).length && d.authors.length) p.authors = d.authors;
              if (!p.series && d.series) { p.series = d.series; if (!p.seriesNo) p.seriesNo = d.seriesNo || ''; }
              if (!p.cover && d.cover) p.cover = d.cover;
            }
          } catch (e) { /* opslag er en hjaelp, ikke et krav */ }
        }
        if (!p.title) return { fejl: 'title is required (or give an ISBN that can be looked up).' };
        const alle = alive(auth.user.id);
        const dup = (p.isbn && alle.find(b => normIsbn(b.isbn) && normIsbn(b.isbn) === normIsbn(p.isbn)))
          || alle.find(b => norm(b.title) === norm(p.title) && lastName((b.authors || [])[0]) === lastName((p.authors || [])[0]));
        if (dup && !a.allow_duplicate) {
          return { fejl: `The library already has "${dup.title}" (id: ${dup.id}). Use update_book to change it, or set allow_duplicate: true.` };
        }
        const bog = Object.assign({
          id: srv.nytId(), isbn: '', title: '', authors: [], cover: '', series: '', seriesNo: '', edition: '', printing: '',
          loaned: false, loanedTo: '', loanedAt: null, owned: false, format: 'paperback', read: false, readYear: null,
          wishlist: false, rating: 0, notes: '', addedAt: new Date().toISOString(), deleted: false
        }, p);
        const gemt = srv.saveBook(auth.user.id, bog);
        return { tekst: 'Added:\n' + beskriv(gemt), data: { book: kort(gemt) } };
      }
    },
    {
      name: 'update_book',
      scope: 'full',
      description: 'Update fields on an existing book (only the fields you pass are changed). Use it to mark a book as '
        + 'read, owned, on the wishlist, lent out/returned, to set a rating or notes, or to correct details.',
      inputSchema: {
        type: 'object',
        properties: Object.assign({ book: { type: 'string', description: 'id, ISBN or exact title of the book to change' } }, BOGFELTER),
        required: ['book']
      },
      kald(a, auth) {
        const b = findBog(auth.user.id, a.book);
        if (!b) return ukendtBog(a.book);
        const f = felterFra(a);
        if (f.fejl) return f;
        if (!Object.keys(f.p).length) return { fejl: 'Nothing to change - pass at least one field.' };
        const gemt = srv.saveBook(auth.user.id, Object.assign({}, b, f.p));
        return { tekst: 'Updated:\n' + beskriv(gemt), data: { book: kort(gemt) } };
      }
    },
    {
      name: 'delete_book',
      scope: 'full',
      description: 'Remove a book from the library (soft delete).',
      inputSchema: { type: 'object', properties: { book: { type: 'string', description: 'id, ISBN or exact title' } }, required: ['book'] },
      kald(a, auth) {
        const b = findBog(auth.user.id, a.book);
        if (!b) return ukendtBog(a.book);
        srv.saveBook(auth.user.id, Object.assign({}, b, { deleted: true }));
        return { tekst: `Deleted "${b.title}" (id ${b.id}).`, data: { id: b.id } };
      }
    },
    {
      name: 'lookup_isbn',
      scope: 'read',
      description: 'Look up an ISBN in the Danish national library catalogue (bibliotek.dk): title, authors, series, cover. '
        + 'Does not change the library - combine with add_book to add it.',
      inputSchema: { type: 'object', properties: { isbn: { type: 'string' } }, required: ['isbn'] },
      async kald(a, auth) {
        const isbn = normIsbn(a.isbn);
        if (!isbn) return { fejl: 'isbn must be 10 or 13 digits.' };
        const d = await srv.lookupIsbn(isbn);
        const egen = alive(auth.user.id).find(b => normIsbn(b.isbn) === isbn);
        if (!d || !d.found) return { tekst: `ISBN ${isbn} was not found in bibliotek.dk.` + (egen ? ` (It IS in the library: id ${egen.id}.)` : ''), data: { found: false, in_library: egen ? egen.id : null } };
        return {
          tekst: `${d.title} – ${d.authors.join(', ')}${d.series ? ` (${d.series}${d.seriesNo ? ' #' + d.seriesNo : ''})` : ''}`
            + (egen ? `\nAlready in the library: id ${egen.id}.` : '\nNot in the library yet.'),
          data: Object.assign({ found: true, isbn, in_library: egen ? egen.id : null }, d)
        };
      }
    },
    {
      name: 'search_catalog',
      scope: 'read',
      description: 'Free-text search (title and/or author) in bibliotek.dk to find a book\'s ISBN and details before adding it.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async kald(a) {
        const d = await srv.lookupSearch(String(a.query || '').trim());
        if (!d || !d.found) return { tekst: `Nothing found in bibliotek.dk for "${a.query}".`, data: { found: false } };
        return {
          tekst: `${d.title} – ${d.authors.join(', ')}${d.series ? ` (${d.series}${d.seriesNo ? ' #' + d.seriesNo : ''})` : ''}${d.isbn ? `\nISBN ${d.isbn}` : ''}`,
          data: Object.assign({ found: true }, d)
        };
      }
    }
  ];

  /* -------------------------------------------------------- json-rpc */

  const fejl = (id, kode, besked, data) => ({
    jsonrpc: '2.0', id: id === undefined ? null : id,
    error: Object.assign({ code: kode, message: besked }, data ? { data } : {})
  });
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

  async function behandl(besked, auth) {
    if (!besked || besked.jsonrpc !== '2.0' || typeof besked.method !== 'string') {
      return fejl(besked && besked.id, -32600, 'Invalid Request');
    }
    const { id, method, params } = besked;

    if (method === 'initialize') {
      const oensket = params && params.protocolVersion;
      return ok(id, {
        protocolVersion: PROTOKOLLER.includes(oensket) ? oensket : PROTOKOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bogreol', title: 'Min Bogreol', version: String(srv.version) },
        instructions:
          'Min Bogreol is a personal book library. Each book has: owned (with format hardback/paperback), read (with '
          + 'the year), wishlist, loaned (to whom, since when), rating 0-5, notes, series and edition/printing. '
          + 'The user\'s language is Danish; answer in the language the user writes. Never invent book ids - find '
          + 'them with search_books, list_books or get_book first. Before adding a book, check for duplicates with '
          + 'search_books; use lookup_isbn/search_catalog to fetch correct details from the Danish library catalogue.'
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;

    if (method === 'tools/list') {
      // Vis kun de vaerktoejer, noeglen faktisk maa bruge - saa foreslaar Claude ikke noget, der giver afslag.
      return ok(id, {
        tools: VAERKTOEJER.filter(v => srv.maa(auth, v.scope)).map(v => ({
          name: v.name, description: v.description, inputSchema: v.inputSchema
        }))
      });
    }

    if (method === 'tools/call') {
      const navn = params && params.name;
      const v = VAERKTOEJER.find(x => x.name === navn);
      if (!v) return fejl(id, -32602, `Unknown tool: ${navn}`);
      // Listen er en hjaelp, ikke en spaerring - scope haandhaeves ogsaa her.
      if (!srv.maa(auth, v.scope)) {
        return ok(id, {
          isError: true,
          content: [{ type: 'text', text: `This access key is "${auth.token.scope}" (read-only) and cannot change the library. Create a "full" key in Min Bogreol under Mere.` }]
        });
      }
      let svar;
      try {
        svar = await v.kald((params && params.arguments) || {}, auth);
      } catch (e) {
        srv.logError(`mcp ${navn}: ${e && e.stack ? e.stack : e}`);
        return ok(id, { isError: true, content: [{ type: 'text', text: 'The tool failed. See the Min Bogreol server log.' }] });
      }
      // Fejl fra vaerktoejet er IKKE protokolfejl - de skal tilbage som et resultat med isError.
      if (svar.fejl) return ok(id, { isError: true, content: [{ type: 'text', text: svar.fejl }] });
      return ok(id, Object.assign(
        { content: [{ type: 'text', text: svar.tekst }] },
        svar.data ? { structuredContent: svar.data } : {}
      ));
    }

    return fejl(id, -32601, `Method not found: ${method}`);
  }

  /* ------------------------------------------------------------ http */

  async function haandter(req, res) {
    // GET og DELETE hoerer til den serverstyrede SSE-stroem, som denne server ikke tilbyder.
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ error: 'method_not_allowed', message: 'Min Bogreol answers MCP on POST only.' }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

    // DNS-rebinding: en browser paa et fremmed site maa ikke kunne naa den her.
    // Kommer der ingen Origin (Claude Code, Desktop), er der intet at tjekke.
    const origin = req.headers.origin;
    if (origin) {
      const vaert = req.headers['x-forwarded-host'] || req.headers.host || '';
      let god = false;
      try { god = new URL(origin).host === String(vaert).split(',')[0].trim(); } catch { god = false; }
      if (!god) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_origin', message: 'Origin not allowed.' }));
        return;
      }
    }

    const auth = srv.godkendMcp(req);
    if (!auth) {
      // WWW-Authenticate er hele indgangen til OAuth: uden resource_metadata kan claude.ai
      // ikke finde autorisationsserveren og opgiver forbindelsen (RFC 9728).
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': srv.oauthUdfordring(req) });
      res.end(JSON.stringify({
        error: 'invalid_key',
        message: 'Send a valid Min Bogreol access key as "Authorization: Bearer br_…", or connect with OAuth.'
      }));
      return;
    }

    let krop;
    try {
      krop = await srv.readMcpBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fejl(null, -32700, 'Parse error')));
      return;
    }

    const flere = Array.isArray(krop);
    const beskeder = flere ? krop : [krop];
    const svar = (await Promise.all(beskeder.map(b => behandl(b, auth)))).filter(Boolean);

    // Kun notifikationer i bundtet: kvitter uden krop, som protokollen kraever.
    if (!svar.length) { res.writeHead(202); res.end(); return; }

    const data = JSON.stringify(flere ? svar : svar[0]);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'MCP-Protocol-Version': PROTOKOL,
      'Content-Length': Buffer.byteLength(data)
    });
    res.end(data);
  }

  return { haandter, VAERKTOEJER, behandl };
}

module.exports = { opret, PROTOKOL };
