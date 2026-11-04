(function () {
	'use strict';

	var state = {
		locations: [],
		hasSearched: false,
		lastLocationQuery: '',
		searchOrigin: null,
		searchRequestId: 0,
		searchMeta: {},
		serviceTypes: [],
		reportCategories: [],
		turnstileSiteKey: '',
		markers: new Map(),
		adminToken: sessionStorage.getItem('ffm-admin-token') || '',
		adminTab: 'suggestions',
		verificationCategory: 'attention',
		verificationPage: 1,
		verificationCounts: [],
		verificationTotal: 0,
		admin: { overview: {}, suggestions: [], reports: [], locations: [], verificationJobs: [] },
	};

	var elements = {
		introView: document.getElementById('intro-view'),
		publicView: document.getElementById('public-view'),
		adminView: document.getElementById('admin-view'),
		introLocationCount: document.getElementById('intro-location-count'),
		results: document.getElementById('results'),
		resultCount: document.getElementById('result-count'),
		searchForm: document.getElementById('search-form'),
		searchService: document.getElementById('search-service'),
		suggestDialog: document.getElementById('suggest-dialog'),
		reportDialog: document.getElementById('report-dialog'),
		confirmDialog: document.getElementById('confirm-dialog'),
		adminDialog: document.getElementById('admin-dialog'),
		reviewDialog: document.getElementById('review-dialog'),
		resolveDialog: document.getElementById('resolve-dialog'),
		adminContent: document.getElementById('admin-content'),
		adminMetrics: document.getElementById('admin-metrics'),
		toast: document.getElementById('toast'),
	};

	function escapeHtml(value) {
		return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
			return {
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#039;',
			}[character];
		});
	}

	function safeWebUrl(value) {
		if (!value) return '';
		try {
			var url = new URL(value);
			return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
		} catch (_error) {
			return '';
		}
	}

	function slugify(value) {
		return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'food-resource';
	}

	function hasCoordinates(location) {
		if (location.latitude == null || location.longitude == null || location.latitude === '' || location.longitude === '') return false;
		var latitude = Number(location.latitude);
		var longitude = Number(location.longitude);
		return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && !(latitude === 0 && longitude === 0);
	}

	function formStatus(form, message, type) {
		var target = form.querySelector('.form-status');
		target.textContent = message || '';
		target.className = 'form-status' + (type ? ' ' + type : '');
	}

	function setBusy(form, busy) {
		var submit = form.querySelector('button[type="submit"]');
		if (!submit) return;
		if (!submit.dataset.label) submit.dataset.label = submit.textContent;
		submit.disabled = busy;
		submit.textContent = busy ? 'Working...' : submit.dataset.label;
	}

	function showToast(message) {
		elements.toast.textContent = message;
		elements.toast.hidden = false;
		window.clearTimeout(showToast.timer);
		showToast.timer = window.setTimeout(function () {
			elements.toast.hidden = true;
		}, 4200);
	}

	async function api(path, options, admin) {
		var init = Object.assign({}, options || {});
		init.headers = Object.assign({ accept: 'application/json' }, init.headers || {});
		if (init.body && typeof init.body !== 'string') {
			init.headers['content-type'] = 'application/json';
			init.body = JSON.stringify(init.body);
		}
		if (admin) init.headers.authorization = 'Bearer ' + state.adminToken;
		var response = await fetch(path, init);
		var data = await response.json().catch(function () {
			return {};
		});
		if (!response.ok) {
			var error = new Error(data.error || 'The request could not be completed.');
			error.status = response.status;
			throw error;
		}
		return data;
	}

	function formObject(form) {
		var data = {};
		new FormData(form).forEach(function (value, key) {
			data[key] = typeof value === 'string' ? value.trim() : value;
		});
		form.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
			data[input.name] = input.checked;
		});
		return data;
	}

	function fillForm(form, record) {
		Array.from(form.elements).forEach(function (control) {
			if (!control.name || !(control.name in record)) return;
			if (control.type === 'checkbox') {
				control.checked = Boolean(record[control.name]);
			} else {
				control.value = record[control.name] == null ? '' : record[control.name];
			}
		});
	}

	function formatDate(value) {
		if (!value) return 'Not yet verified';
		var date = new Date(value);
		if (Number.isNaN(date.getTime())) return String(value);
		return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
	}

	function verificationLabel(location) {
		var date = location.last_verified_at ? formatDate(location.last_verified_at) : '';
		if (location.verification_status === 'verified') return 'Verified' + (date ? ' ' + date : '');
		if (location.verification_status === 'partial') return 'Partially checked' + (date ? ' ' + date : '');
		if (location.verification_status === 'needs_review') return 'Needs review';
		return 'Not yet verified';
	}

	function verifiedFieldLabel(value) {
		if (!value) return '';
		var labels = { zip: 'ZIP', phone: 'phone', email: 'email', website: 'website', service: 'service type' };
		return String(value)
			.split(',')
			.filter(Boolean)
			.map(function (field) { return labels[field] || field; })
			.join(', ');
	}

	function verificationSummary(location) {
		var status = location.verification_status || 'unverified';
		var icons = { verified: 'badge-check', partial: 'shield-question', needs_review: 'circle-alert', unverified: 'shield-question' };
		return '<div class="verification-summary ' + escapeHtml(status) + '"><i data-lucide="' +
			escapeHtml(icons[status] || icons.unverified) + '" aria-hidden="true"></i><span>' +
			escapeHtml(verificationLabel(location)) + '</span></div>';
	}

	function markerColor(serviceType) {
		var colors = {
			'Food Bank': '#1e407c',
			'Food Pantry': '#007377',
			'Soup Kitchen': '#b33d28',
			'Support Services': '#6b4c9a',
			'Emergency Food': '#9b2c2c',
			'Food Distribution': '#8a5a16',
			Other: '#46534b',
		};
		return colors[serviceType] || colors.Other;
	}

	var map = null;
	var markerLayer = null;
	var mapAssetsPromise = null;

	function loadStylesheet(href) {
		if (document.querySelector('link[href="' + href + '"]')) return;
		var link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		document.head.appendChild(link);
	}

	function loadScript(src) {
		return new Promise(function (resolve, reject) {
			var existing = document.querySelector('script[src="' + src + '"]');
			if (existing) {
				if (existing.dataset.loaded) resolve();
				else existing.addEventListener('load', resolve, { once: true });
				return;
			}
			var script = document.createElement('script');
			script.src = src;
			script.addEventListener('load', function () { script.dataset.loaded = 'true'; resolve(); }, { once: true });
			script.addEventListener('error', function (error) { script.remove(); reject(error); }, { once: true });
			document.head.appendChild(script);
		});
	}

	function loadMapAssets() {
		if (!mapAssetsPromise) {
			loadStylesheet('/leaflet.css');
			loadStylesheet('/MarkerCluster.css');
			loadStylesheet('/MarkerCluster.Default.css');
			mapAssetsPromise = loadScript('/leaflet.js').then(function () { return loadScript('/leaflet.markercluster.js'); }).catch(function (error) { mapAssetsPromise = null; throw error; });
		}
		return mapAssetsPromise;
	}

	async function initializeMap() {
		try {
			await loadMapAssets();
		} catch (_error) {
			document.getElementById('map').innerHTML = '<div class="empty-state"><strong>Map unavailable</strong>The location list still works.</div>';
			return;
		}
		if (map || !window.L) return;
		map = window.L.map('map', { zoomControl: true }).setView([40.86, -77.67], 7);
		window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
		}).addTo(map);
		markerLayer = window.L.markerClusterGroup ? window.L.markerClusterGroup({ animate: false, showCoverageOnHover: false, maxClusterRadius: 48 }) : window.L.layerGroup();
		markerLayer.addTo(map);
	}

	function popupHtml(location) {
		return (
			'<div class="map-popup"><strong>' +
			escapeHtml(location.name) +
			'</strong><span>' +
			escapeHtml(location.service_type) +
			'</span><span>' +
			escapeHtml(location.address) +
			'</span></div>'
		);
	}

	function renderMap(locations) {
		if (!map || !markerLayer) return;
		markerLayer.clearLayers();
		state.markers.clear();
		var bounds = [];
		locations.forEach(function (location) {
			if (!hasCoordinates(location)) return;
			var latitude = Number(location.latitude);
			var longitude = Number(location.longitude);
			var marker = window.L.marker([latitude, longitude], {
				title: location.name,
				alt: location.name,
				icon: window.L.divIcon({ className: 'food-map-marker', html: '<span style="background:' + markerColor(location.service_type) + '"></span>', iconSize: [18,18], iconAnchor: [9,9], popupAnchor: [0,-10] }),
			})
				.bindPopup(popupHtml(location))
				.on('click', function () {
					setMobileView('list');
					selectResult(location.id, false);
				})
				.addTo(markerLayer);
			state.markers.set(Number(location.id), marker);
			bounds.push([latitude, longitude]);
		});
		if (bounds.length === 0) map.setView([40.86, -77.67], 7);
		else if (bounds.length === 1) map.setView(bounds[0], 14);
		else if (bounds.length > 1) map.fitBounds(bounds, { animate: false, padding: [40, 40], maxZoom: 13 });
	}

	function detailsRow(label, value, link) {
		if (!value) return '';
		var rendered = escapeHtml(value);
		if (link) rendered = '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener">' + rendered + '</a>';
		return '<dt>' + escapeHtml(label) + '</dt><dd>' + rendered + '</dd>';
	}

	function locationCard(location) {
		var website = safeWebUrl(location.contact_web);
		var directions = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(location.address + ' ' + location.zip_code);
		var phone = location.contact_phone ? String(location.contact_phone).replace(/[^\d+]/g, '') : '';
		var organization = location.organization_name
			? '<div class="result-hours"><i data-lucide="building-2" aria-hidden="true"></i><span>' + escapeHtml(location.organization_name) + '</span></div>'
			: '';
		var hours = location.hours
			? '<div class="result-hours"><i data-lucide="clock-3" aria-hidden="true"></i><span>' + escapeHtml(location.hours) + '</span></div>'
			: '';
		var availability = location.has_structured_hours
			? '<span class="availability-tag ' + (location.is_open_now ? 'open' : 'closed') + '">' + (location.is_open_now ? 'Open now' : 'Closed now') + '</span>'
			: '';
		var signalLabels = { open: 'Reported open', hours_correct: 'Hours confirmed', food_available: 'Food reported available', temporary_closed: 'Reported temporarily closed', long_wait: 'Long wait reported' };
		var communityUpdate = location.recent_confirmation_signal
			? '<div class="community-update"><i data-lucide="users-round" aria-hidden="true"></i><span>' + escapeHtml(signalLabels[location.recent_confirmation_signal] || 'Recent community update') + ' ' + escapeHtml(formatDate(location.recent_confirmation_at)) + '</span></div>'
			: '';
		var distance = location.distance_miles != null ? '<span class="distance-label">' + Number(location.distance_miles).toFixed(1) + ' mi</span>' : '';
		var call = phone
			? '<a class="button button-secondary button-small" href="tel:' + escapeHtml(phone) + '"><i data-lucide="phone" aria-hidden="true"></i>Call</a>'
			: '';
		var site = website
			? '<a class="button button-secondary button-small" href="' + escapeHtml(website) + '" target="_blank" rel="noopener"><i data-lucide="external-link" aria-hidden="true"></i>Website</a>'
			: '';
		var mapAction = hasCoordinates(location)
			? '<button class="button button-secondary button-small" type="button" data-view-on-map="' +
				Number(location.id) +
				'"><i data-lucide="map-pin" aria-hidden="true"></i>View map</button>'
			: '<span class="map-pending"><i data-lucide="map-pin-off" aria-hidden="true"></i>Map pending</span>';
		return (
			'<details class="result-card" data-location-id="' +
			Number(location.id) +
			'"><summary><div class="result-title-row"><h2>' +
			escapeHtml(location.name) +
			'</h2><span class="service-tag">' +
			escapeHtml(location.service_type) +
			'</span></div><div class="result-status-row">' + availability + distance + '</div><address>' +
			escapeHtml(location.address) +
			'</address>' + verificationSummary(location) +
			organization +
			hours +
			communityUpdate +
			'</summary><div class="result-details"><dl>' +
			detailsRow('Phone', location.contact_phone, phone ? 'tel:' + phone : '') +
			detailsRow('Email', location.contact_email, location.contact_email ? 'mailto:' + location.contact_email : '') +
			detailsRow('Eligibility', location.eligibility) +
			detailsRow('Accessibility', location.accessibility) +
			detailsRow('Languages', location.languages) +
			detailsRow('Appointment', location.appointment_required ? 'Required' : '') +
			detailsRow('Notes', location.notes) +
			'</dl><div class="result-links">' +
			call +
			site +
			mapAction +
			'<a class="button button-secondary button-small" href="/locations/' + Number(location.id) + '/' + escapeHtml(slugify(location.name)) + '"><i data-lucide="info" aria-hidden="true"></i>Details</a>' +
			'<button class="button button-secondary button-small" type="button" data-share-id="' + Number(location.id) + '"><i data-lucide="share-2" aria-hidden="true"></i>Share</button>' +
			'<button class="button button-secondary button-small" type="button" data-confirm-id="' + Number(location.id) + '"><i data-lucide="message-circle" aria-hidden="true"></i>Visit update</button>' +
			'<a class="button button-secondary button-small" href="' +
			escapeHtml(directions) +
			'" rel="noopener"><i data-lucide="navigation" aria-hidden="true"></i>Directions</a>' +
			'<button class="button button-danger button-small" type="button" data-report-id="' +
			Number(location.id) +
			'"><i data-lucide="flag" aria-hidden="true"></i>Report</button></div></div></details>'
		);
	}

	function renderLocations() {
		var meta = state.searchMeta || {};
		var summary = document.getElementById('search-summary');
		summary.textContent = meta.zip_center_unavailable
			? 'Could not locate ZIP ' + meta.origin_zip + '. Showing exact ZIP matches only; the distance filter is unavailable. Try again or use your location.'
			: meta.radius_miles ? 'Within ' + meta.radius_miles + (meta.radius_miles === 1 ? ' mile of ' : ' miles of ') + (meta.approximate_origin ? 'the approximate center of ZIP ' + meta.origin_zip : 'your location') + '. Distances are straight-line estimates.' : '';
		summary.hidden = !summary.textContent;
		if (meta.using_saved_data) { summary.textContent += ' Showing a saved public listing while live updates are temporarily unavailable. Call before visiting.'; summary.hidden = false; }
		elements.resultCount.textContent =
			state.locations.length === 1 ? '1 location' : state.locations.length + ' locations';
		if (!state.locations.length) {
			elements.results.innerHTML =
				'<div class="empty-state"><strong>No matches found</strong>' + (meta.radius_miles ? 'Try increasing the distance or removing a filter.' : 'Try removing a filter or suggest a missing location.') + '</div>';
		} else {
			elements.results.innerHTML = state.locations.map(locationCard).join('');
		}
		renderMap(state.locations);
		refreshIcons();
	}

	function resetLocationsPrompt() {
		state.searchRequestId += 1;
		state.searchOrigin = null;
		state.searchMeta = {};
		document.getElementById('search-summary').hidden = true;
		state.locations = [];
		state.hasSearched = false;
		state.lastLocationQuery = '';
		elements.resultCount.textContent = 'Search by ZIP code';
		elements.results.innerHTML = '<div class="empty-state"><strong>Find food near you</strong>Enter a ZIP code or use your location to begin.</div>';
		renderMap([]);
		refreshIcons();
	}

	function selectResult(id, openMarker) {
		var card = elements.results.querySelector('[data-location-id="' + Number(id) + '"]');
		elements.results.querySelectorAll('.result-card.selected').forEach(function (item) {
			item.classList.remove('selected');
		});
		if (card) {
			card.classList.add('selected');
			card.open = true;
			if (!window.matchMedia('(max-width: 640px)').matches || elements.publicView.dataset.mobileView !== 'map') {
				card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}
		}
		var marker = state.markers.get(Number(id));
		if (marker && map) {
			if (openMarker && markerLayer.zoomToShowLayer) {
				map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16), { animate: false });
				var parent = markerLayer.getVisibleParent(marker);
				if (parent && parent !== marker && parent.spiderfy) parent.spiderfy();
				marker.openPopup();
				return;
			}
			if (openMarker) marker.openPopup();
			if (openMarker && window.matchMedia('(max-width: 640px)').matches) {
				map.setView(marker.getLatLng(), Math.max(map.getZoom(), 13), { animate: true });
			} else {
				map.panTo(marker.getLatLng(), { animate: true });
			}
		}
	}

	async function loadLocations(options) {
		options = options || {};
		var requestId = ++state.searchRequestId;
		elements.resultCount.textContent = 'Loading locations...';
		var params = new URLSearchParams();
		var formData = formObject(elements.searchForm);
		if (options.all) state.searchOrigin = { all: true };
		else if (options.latitude != null && options.longitude != null) state.searchOrigin = { latitude: options.latitude, longitude: options.longitude };
		else if (formData.zip) state.searchOrigin = null;
		if (!formData.zip && !options.all && options.latitude == null && state.searchOrigin) options = state.searchOrigin;
		if (!options.all && options.latitude == null && !/^\d{5}$/.test(formData.zip || '')) {
			elements.resultCount.textContent = 'ZIP code required';
			elements.results.innerHTML = '<div class="empty-state"><strong>Enter a five-digit ZIP code</strong>Or use your location to search nearby.</div>';
			document.getElementById('search-zip').focus();
			return;
		}
		if (formData.q) params.set('q', formData.q);
		if (formData.zip) params.set('zip', formData.zip);
		if (formData.service) params.set('service', formData.service);
		if (formData.has_hours) params.set('has_hours', 'true');
		if (formData.open_now) params.set('open_now', 'true');
		if (!options.all) params.set('radius', formData.radius || '5');
		if (options.all) params.set('all', 'true');
		if (options.latitude != null && options.longitude != null) {
			params.delete('zip');
			params.set('lat', Number(options.latitude).toFixed(3));
			params.set('lon', Number(options.longitude).toFixed(3));
		}
		try {
			state.lastLocationQuery = params.toString();
			var data = await searchPublicLocations(state.lastLocationQuery);
			if (requestId !== state.searchRequestId) return;
			state.locations = data.locations || [];
			state.searchMeta = data.meta || {};
			state.hasSearched = true;
			renderLocations();
		} catch (error) {
			if (requestId !== state.searchRequestId) return;
			elements.resultCount.textContent = 'Locations unavailable';
			elements.results.innerHTML =
				'<div class="empty-state"><strong>Could not load the map data</strong>' +
				escapeHtml(error.message) +
				'</div>';
		}
	}


	var publicListings;
	var zipCenters;
	var snapshotSearch;

	function loadPublicListings() {
		if (!publicListings) publicListings = api('/location-snapshot.json').catch(function (error) {
			publicListings = null;
			throw error;
		});
		return publicListings;
	}

	async function searchPublicLocations(query) {
		var params = new URLSearchParams(query);
		var zip = (params.get('zip') || '').trim();
		if (zip && !/^\d{5}$/.test(zip)) throw new Error('Enter a valid five-digit ZIP code.');
		var radius = Number(params.get('radius') || 5);
		if (!Number.isFinite(radius) || radius < 1 || radius > 100) throw new Error('Choose a distance between 1 and 100 miles.');
		var lat = null;
		var lon = null;
		if (params.has('lat') && params.has('lon')) {
			lat = Number(params.get('lat'));
			lon = Number(params.get('lon'));
		} else if (zip) {
			if (!zipCenters) zipCenters = api('/zip-centers.json').catch(function () {
				zipCenters = null;
				return {};
			});
			var center = (await zipCenters)[zip];
			if (center) { lat = center[0]; lon = center[1]; }
		}
		if (!snapshotSearch) snapshotSearch = import('/snapshot-search.mjs');
		var results = await Promise.all([loadPublicListings(), snapshotSearch]);
		return results[1].searchSnapshot(results[0], params, lat, lon, radius);
	}

	async function reloadLocations() {
		if (!state.lastLocationQuery) return;
		var requestId = ++state.searchRequestId;
		try {
			var data = await searchPublicLocations(state.lastLocationQuery);
			if (requestId !== state.searchRequestId) return;
			state.locations = data.locations || [];
			state.searchMeta = data.meta || {};
			renderLocations();
		} catch (_error) {}
	}

	async function loadStats() {
		try {
			var data = await loadPublicListings();
			var total = data.locations.length;
			if (total) elements.introLocationCount.textContent = total.toLocaleString();
			var unmapped = data.locations.filter(function (location) { return !hasCoordinates(location); }).length;
			var published = data.snapshot_at ? 'Listings published ' + formatDate(data.snapshot_at) + '. ' : '';
			document.getElementById('admin-listing-summary').textContent =
				published + 'Listings without a confirmed map position: ' + unmapped + '.';
		} catch (_error) {}
	}

	function openReport(locationId) {
		var location = state.locations.find(function (item) {
			return Number(item.id) === Number(locationId);
		});
		if (!location) return;
		var form = document.getElementById('report-form');
		form.reset();
		form.elements.location_id.value = location.id;
		document.getElementById('report-location-name').textContent = location.name + ' - ' + location.address;
		formStatus(form, '');
		elements.reportDialog.showModal();
	}

	function openConfirmation(locationId) {
		var location = state.locations.find(function (item) { return Number(item.id) === Number(locationId); });
		if (!location) return;
		var form = document.getElementById('confirm-form');
		form.reset();
		form.elements.location_id.value = location.id;
		document.getElementById('confirm-location-name').textContent = location.name + ' - ' + location.address;
		formStatus(form, '');
		elements.confirmDialog.showModal();
	}

	async function shareLocation(locationId) {
		var location = state.locations.find(function (item) { return Number(item.id) === Number(locationId); });
		if (!location) return;
		var url = new URL('/locations/' + Number(location.id) + '/' + slugify(location.name), window.location.origin).toString();
		if (navigator.share) {
			try { await navigator.share({ title: location.name, text: location.service_type + ' at ' + location.address, url: url }); return; } catch (error) { if (error.name === 'AbortError') return; }
		}
		try { await navigator.clipboard.writeText(url); showToast('Location link copied.'); } catch (_error) { window.prompt('Copy this location link:', url); }
	}

	function refreshIcons() {
		if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 2 } });
	}

	function populateOptions() {
		var serviceMarkup = state.serviceTypes
			.map(function (service) {
				return '<option value="' + escapeHtml(service) + '">' + escapeHtml(service) + '</option>';
			})
			.join('');
		elements.searchService.insertAdjacentHTML('beforeend', serviceMarkup);
		document.querySelectorAll('[data-service-select]').forEach(function (select) {
			select.insertAdjacentHTML('beforeend', serviceMarkup);
		});
		document.getElementById('report-category').insertAdjacentHTML(
			'beforeend',
			state.reportCategories
				.map(function (category) {
					return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>';
				})
				.join(''),
		);
	}

	function configureTurnstile(siteKey) {
		if (!siteKey) return;
		document.querySelectorAll('[data-turnstile-form]').forEach(function (slot) {
			slot.classList.add('cf-turnstile');
			slot.dataset.sitekey = siteKey;
			slot.dataset.theme = 'light';
		});
		loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit').then(function () {
			window.turnstile.ready(function () {
				document.querySelectorAll('[data-turnstile-form]').forEach(function (slot) {
					var form = document.getElementById(slot.dataset.turnstileForm);
					form.dataset.turnstileWidget = window.turnstile.render(slot, { sitekey: siteKey, callback: function (token) { form.elements.turnstile_token.value = token; } });
				});
			});
		}).catch(function () { showToast('Human verification could not load. Please reload to try again.'); });
	}

	async function loadMeta() {
		try {
			var data = await api('/api/meta');
			state.serviceTypes = data.service_types || [];
			state.reportCategories = data.report_categories || [];
			state.turnstileSiteKey = data.turnstile_site_key || '';
			populateOptions();
			configureTurnstile(state.turnstileSiteKey);
		} catch (error) {
			console.error(error);
		}
	}

	function metric(label, value) {
		return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + Number(value || 0) + '</strong></div>';
	}

	function renderAdminMetrics() {
		var counts = state.admin.overview || {};
			elements.adminMetrics.innerHTML =
			metric('Active locations', counts.active_locations) +
			metric('Verified', counts.verified_locations) +
			metric('Partially checked', counts.partially_verified_locations) +
			metric('Needs review', counts.locations_needing_review) +
			metric('Pending suggestions', counts.pending_suggestions) +
			metric('Open reports', counts.open_reports) +
			metric('Recent visit updates', counts.recent_confirmations) +
			metric('Structured hours', counts.locations_with_structured_hours) +
			metric('Verification queue', counts.verification_jobs_needing_review);
		document.getElementById('suggestion-count').textContent = state.admin.suggestions.length
			? state.admin.suggestions.length
			: '';
		document.getElementById('report-count').textContent = state.admin.reports.length ? state.admin.reports.length : '';
		var attentionCount = state.verificationCounts.filter(function (c) { return c.reason !== 'confirmed' && c.reason !== 'running' && c.reason !== 'mapping'; }).reduce(function (sum,c) { return sum+c.total; },0);
		document.getElementById('verification-count').textContent = attentionCount || '';
	}

	function queueEmpty(title, copy) {
		return '<div class="empty-state"><strong>' + escapeHtml(title) + '</strong>' + escapeHtml(copy) + '</div>';
	}

	function renderSuggestions() {
		if (!state.admin.suggestions.length) return queueEmpty('Suggestion queue is clear', '');
		return (
			'<div class="queue-list">' +
			state.admin.suggestions
				.map(function (item) {
					var warning = item.duplicate_of_location_id
						? '<div class="queue-warning"><strong>Possible duplicate:</strong> ' +
							escapeHtml(item.duplicate_name) +
							' at ' +
							escapeHtml(item.duplicate_address) +
							'</div>'
						: '';
					return (
						'<article class="queue-item"><div class="queue-main"><div class="queue-title-row"><h2>' +
						escapeHtml(item.name) +
						'</h2><span class="status-tag pending">Pending</span></div><div class="queue-meta"><span>' +
						escapeHtml(item.address) +
						'</span><span>' +
						escapeHtml(item.zip_code) +
						'</span><span>' +
						escapeHtml(item.service_type) +
						'</span></div><div class="queue-detail"><span>Submitted ' +
						escapeHtml(formatDate(item.submitted_at)) +
						'</span>' +
						(item.source_url ? '<a href="' + escapeHtml(safeWebUrl(item.source_url)) + '" target="_blank" rel="noopener">View source</a>' : '') +
						'</div>' +
						warning +
						'</div><div class="item-actions"><button class="button button-danger button-small" type="button" data-reject-suggestion="' +
						Number(item.id) +
						'">Reject</button><button class="button button-primary button-small" type="button" data-review-suggestion="' +
						Number(item.id) +
						'">Review</button></div></article>'
					);
				})
				.join('') +
			'</div>'
		);
	}

	function renderReports() {
		if (!state.admin.reports.length) return queueEmpty('Report queue is clear', '');
		return (
			'<div class="queue-list">' +
			state.admin.reports
				.map(function (item) {
					return (
						'<article class="queue-item"><div class="queue-main"><div class="queue-title-row"><h2>' +
						escapeHtml(item.location_name) +
						'</h2><span class="status-tag open">Open</span></div><div class="queue-meta"><span>' +
						escapeHtml(item.category) +
						'</span><span>' +
						escapeHtml(item.location_address) +
						'</span><span>Submitted ' +
						escapeHtml(formatDate(item.submitted_at)) +
						'</span></div><div class="queue-detail"><span>' +
						escapeHtml(item.description) +
						'</span></div></div><div class="item-actions"><button class="button button-primary button-small" type="button" data-resolve-report="' +
						Number(item.id) +
						'">Resolve</button></div></article>'
					);
				})
				.join('') +
			'</div>'
		);
	}

	function renderAdminLocations() {
		if (!state.admin.locations.length) return queueEmpty('No locations yet', '');
		return (
			'<div class="queue-list">' +
			state.admin.locations
				.map(function (item) {
					var coordinate = item.latitude == null ? 'Coordinates pending' : 'Mapped';
					return (
						'<article class="queue-item"><div class="queue-main"><div class="queue-title-row"><h2>' +
						escapeHtml(item.name) +
						'</h2><span class="status-tag ' +
						escapeHtml(item.status) +
						'">' +
						escapeHtml(item.status) +
						'</span></div><div class="queue-meta"><span>' +
						escapeHtml(item.address) +
						'</span><span>' +
						escapeHtml(item.service_type) +
						'</span><span>' +
						escapeHtml(coordinate) +
						'</span><span>' +
						escapeHtml(verificationLabel(item)) +
						'</span></div></div><div class="item-actions"><button class="button button-secondary button-small" type="button" data-run-verification="' +
						Number(item.id) +
						'"><i data-lucide="scan-search" aria-hidden="true"></i>Verify source</button><button class="button button-secondary button-small" type="button" data-edit-location="' +
						Number(item.id) +
						'"><i data-lucide="pencil" aria-hidden="true"></i>Edit</button></div></article>'
					);
				})
				.join('') +
			'</div>'
		);
	}

	function renderVerificationJobs() {
		var counts = {};
		state.verificationCounts.forEach(function (c) { counts[c.reason] = c.total; });
		counts.attention = ['identity','hours','contact','other','failed'].reduce(function (sum,k) { return sum + (counts[k] || 0); },0);
		var guidance = {
			attention: 'Scheduled and admin-started checks that need review. Compare unmatched fields with the source before editing.',
			identity: 'The source did not confirm the name, address, or ZIP. Confirm the site identity and street address.',
			hours: 'The source did not confirm the hours. Check the current food distribution schedule.',
			contact: 'The source did not confirm the phone number. Check the current public number.',
			other: 'The check needs review for another reason. Read the evidence and confirm any outstanding details.',
			failed: 'The check could not read the source. Try the link or find a current source, then rerun the check.',
			mapping: 'Active listings without coordinates. Confirm the full street address and correct it if needed.',
			running: 'Checks are queued or running. Refresh later to see the results.',
			confirmed: 'The latest check completed successfully. Review the evidence to see what matched.'
		};
		var tabs = '<div class="verification-tabs" role="tablist" aria-label="Verification reasons">' + [['attention','Needs attention'],['identity','Name / address'],['hours','Hours'],['contact','Contact'],['other','Other changes'],['failed','Source unavailable'],['mapping','Map positions'],['running','In progress'],['confirmed','Completed']].map(function (entry) {
			return '<button type="button" role="tab" class="button button-secondary button-small" aria-selected="' + (state.verificationCategory === entry[0]) + '" data-verification-category="' + entry[0] + '">' + entry[1] + ' (' + (counts[entry[0]] || 0) + ')</button>';
		}).join('') + '</div><p>' + escapeHtml(guidance[state.verificationCategory]) + '</p>';
		var navigation = '<div class="toolbar-actions"><button class="button button-secondary" data-verification-page="' + (state.verificationPage-1) + '" ' + (state.verificationPage <= 1 ? 'disabled' : '') + '>Previous</button><span>Page ' + state.verificationPage + ' &middot; ' + state.verificationTotal + ' locations</span><button class="button button-secondary" data-verification-page="' + (state.verificationPage+1) + '" ' + (state.verificationPage*50 >= state.verificationTotal ? 'disabled' : '') + '>Next</button></div>';
		if (!state.admin.verificationJobs.length) return tabs + queueEmpty('Nothing to review here', '') + navigation;
		return tabs + '<div class="queue-list">' + state.admin.verificationJobs.map(function (job) {
			var detail = '';
			try {
				var evidence = JSON.parse(job.evidence_json || '{}');
				detail = (evidence.checks || []).map(function (check) { return check.field + ': ' + (check.confirmed ? 'matched' : 'not found'); }).join(', ');
			} catch (_error) {}
			return '<article class="queue-item"><div class="queue-main"><div class="queue-title-row"><h2>' + escapeHtml(job.location_name) + '</h2><span class="status-tag ' + escapeHtml(job.status) + '">' + escapeHtml(job.status) + '</span></div><div class="queue-meta"><span>' + escapeHtml(job.location_address) + '</span><span>Checked ' + escapeHtml(formatDate(job.completed_at || job.started_at || job.scheduled_for)) + '</span></div><div class="queue-detail"><span>' + escapeHtml(detail || job.error_message || 'Waiting for source check') + '</span>' + (job.source_url ? '<a href="' + escapeHtml(safeWebUrl(job.source_url)) + '" target="_blank" rel="noopener">View source</a>' : '') + '</div></div><div class="item-actions"><button class="button button-secondary button-small" type="button" data-edit-location="' + Number(job.location_id) + '"><i data-lucide="pencil" aria-hidden="true"></i>Review record</button></div></article>';
		}).join('') + '</div>' + navigation;
	}

	function renderAdminContent() {
		if (state.adminTab === 'suggestions') elements.adminContent.innerHTML = '<p>Community submissions awaiting approval. Check the source, address, and possible duplicates before publishing.</p>' + renderSuggestions();
		if (state.adminTab === 'reports') elements.adminContent.innerHTML = '<p>Issues visitors reported on existing listings. Check the issue, update the listing if needed, then resolve the report.</p>' + renderReports();
		if (state.adminTab === 'locations') elements.adminContent.innerHTML = '<p>Imported listings and approved suggestions. Edit listing details or start an automated source check.</p>' + renderAdminLocations();
		if (state.adminTab === 'verification-jobs') elements.adminContent.innerHTML = renderVerificationJobs();
		refreshIcons();
	}

	async function loadAdmin() {
		elements.adminContent.innerHTML = '<div class="loading-state">Loading review queue...</div>';
		try {
			var values = await Promise.all([
				api('/api/admin/overview', {}, true),
				api('/api/admin/suggestions', {}, true),
				api('/api/admin/reports', {}, true),
				api('/api/admin/locations', {}, true),
				api('/api/admin/verification-jobs?category=' + state.verificationCategory + '&page=' + state.verificationPage, {}, true),
			]);
			state.admin.overview = values[0].counts || {};
			state.admin.suggestions = values[1].suggestions || [];
			state.admin.reports = values[2].reports || [];
			state.admin.locations = values[3].locations || [];
			state.admin.verificationJobs = values[4].verification_jobs || [];
			state.verificationCounts = values[4].counts || [];
			state.verificationTotal = values[4].total || 0;
			renderAdminMetrics();
			renderAdminContent();
		} catch (error) {
			if (error.status === 401) {
				state.adminToken = '';
				sessionStorage.removeItem('ffm-admin-token');
				showMapView();
				elements.adminDialog.showModal();
				formStatus(document.getElementById('admin-form'), 'That admin key was not accepted.', 'error');
				return;
			}
			elements.adminContent.innerHTML = queueEmpty('Could not load the queue', error.message);
		}
	}

	function showIntroView(updateHash) {
		elements.introView.hidden = false;
		elements.publicView.hidden = true;
		elements.adminView.hidden = true;
		if (updateHash !== false && window.location.hash !== '#home') window.location.hash = 'home';
		window.scrollTo({ top: 0, behavior: 'auto' });
	}

	function setMobileView(view) {
		var nextView = view === 'list' ? 'list' : 'map';
		elements.publicView.dataset.mobileView = nextView;
		document.querySelectorAll('[data-mobile-view-target]').forEach(function (button) {
			var active = button.dataset.mobileViewTarget === nextView;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', String(active));
		});
		if (nextView === 'map') {
			return new Promise(function (resolve) { window.setTimeout(async function () {
				if (!map) await initializeMap();
				if (map) {
					map.invalidateSize();
					renderMap(state.locations);
				}
				resolve();
			}, 10); });
		}
		return Promise.resolve();
	}

	async function showMapView(updateHash) {
		elements.introView.hidden = true;
		elements.publicView.hidden = false;
		elements.adminView.hidden = true;
		if (updateHash !== false && window.location.hash !== '#map') window.location.hash = 'map';
		window.setTimeout(async function () {
			if (window.matchMedia('(max-width: 640px)').matches && elements.publicView.dataset.mobileView !== 'map') return;
			if (!map) await initializeMap();
			if (map) {
				map.invalidateSize();
				renderMap(state.locations);
			}
		}, 10);
	}

	async function showAdminView(updateHash) {
		elements.introView.hidden = true;
		elements.publicView.hidden = true;
		elements.adminView.hidden = false;
		if (updateHash !== false && window.location.hash !== '#admin') window.location.hash = 'admin';
		await loadAdmin();
	}

	function routeFromHash() {
		if (window.location.hash === '#map') return showMapView(false);
		if (window.location.hash === '#admin') return showAdminView(false);
		showIntroView(false);
	}

	function openReviewDialog(record, mode) {
		var form = document.getElementById('review-form');
		form.reset();
		fillForm(form, Object.assign({}, record, { id: record.id, mode: mode }));
		form.elements.mode.value = mode;
		form.elements.id.value = record.id;
		document.getElementById('duplicate-warning').hidden = true;
		var checkedFields = document.getElementById('review-checked-fields');
		var fields = mode === 'location' ? verifiedFieldLabel(record.verified_fields) : '';
		checkedFields.hidden = !fields;
		checkedFields.textContent = fields ? 'Checked fields: ' + fields : '';
		var source = document.getElementById('review-verification-source');
		var sourceUrl = mode === 'location' ? safeWebUrl(record.verification_source_url) : '';
		source.hidden = !sourceUrl;
		source.removeAttribute('href');
		if (sourceUrl) source.href = sourceUrl;
		if (mode === 'suggestion') {
			document.getElementById('review-eyebrow').textContent = 'Pending suggestion';
			document.getElementById('review-title').textContent = 'Review and publish';
			document.getElementById('review-submit').textContent = 'Approve and publish';
			document.getElementById('verified-control').hidden = true;
			if (record.duplicate_of_location_id) {
				var warning = document.getElementById('duplicate-warning');
				warning.textContent = 'Possible duplicate: ' + record.duplicate_name + ' at ' + record.duplicate_address;
				warning.hidden = false;
			}
		} else {
			document.getElementById('review-eyebrow').textContent = 'Published location';
			document.getElementById('review-title').textContent = 'Edit location';
			document.getElementById('review-submit').textContent = 'Save changes';
			document.getElementById('verified-control').hidden = false;
		}
		formStatus(form, '');
		elements.reviewDialog.showModal();
	}

	document.addEventListener('click', async function (event) {
		var close = event.target.closest('[data-close-dialog]');
		if (close) {
			var dialog = close.closest('dialog');
			if (dialog) dialog.close();
			return;
		}
		var viewOnMapButton = event.target.closest('[data-view-on-map]');
		if (viewOnMapButton) {
			await setMobileView('map');
			selectResult(viewOnMapButton.dataset.viewOnMap, true);
			return;
		}
		var reportButton = event.target.closest('[data-report-id]');
		if (reportButton) openReport(reportButton.dataset.reportId);
		var confirmButton = event.target.closest('[data-confirm-id]');
		if (confirmButton) openConfirmation(confirmButton.dataset.confirmId);
		var shareButton = event.target.closest('[data-share-id]');
		if (shareButton) shareLocation(shareButton.dataset.shareId);
	});

	elements.results.addEventListener('toggle', function (event) {
		if (event.target.open) selectResult(event.target.dataset.locationId, true);
	}, true);

	elements.searchForm.addEventListener('submit', function (event) {
		event.preventDefault();
		loadLocations();
	});

	document.getElementById('clear-search').addEventListener('click', function () {
		elements.searchForm.reset();
		resetLocationsPrompt();
	});

	document.getElementById('show-all-locations').addEventListener('click', function () {
		document.getElementById('search-zip').value = '';
		loadLocations({ all: true });
	});

		document.getElementById('locate-button').addEventListener('click', function () {
		if (!navigator.geolocation) return showToast('Location is not available in this browser.');
			navigator.geolocation.getCurrentPosition(
			function (position) {
				document.getElementById('search-zip').value = '';
				loadLocations({ latitude: position.coords.latitude, longitude: position.coords.longitude });
				if (map) map.setView([position.coords.latitude, position.coords.longitude], 12);
			},
			function () {
				showToast('We could not access your location.');
			},
			{ enableHighAccuracy: false, timeout: 8000 },
		);
	});

	document.getElementById('suggest-button').addEventListener('click', function () {
		var form = document.getElementById('suggest-form');
		form.reset();
		formStatus(form, '');
		elements.suggestDialog.showModal();
	});

	document.querySelectorAll('[data-mobile-view-target]').forEach(function (button) {
		button.addEventListener('click', function () {
			setMobileView(button.dataset.mobileViewTarget);
		});
	});

	document.getElementById('map-button').addEventListener('click', function () {
		showMapView();
		setMobileView('map');
	});
	document.getElementById('open-map-button').addEventListener('click', function () {
		showMapView();
		setMobileView('list');
	});
	document.getElementById('open-map-bottom-button').addEventListener('click', function () {
		showMapView();
		setMobileView('list');
	});
	document.getElementById('admin-button').addEventListener('click', showAdminView);
	document.getElementById('exit-admin').addEventListener('click', showMapView);
	document.getElementById('publish-map').addEventListener('click', async function (event) {
		var button = event.currentTarget;
		var status = document.getElementById('publish-map-status');
		var link = document.getElementById('publish-map-run');
		button.disabled = true;
		link.hidden = true;
		status.textContent = 'Starting publication…';
		try {
			var result = await api('/api/admin/publish', { method: 'POST' }, true);
			status.textContent = 'Publication queued. Map changes go live after the publishing run succeeds.';
			link.href = result.run_url;
			link.hidden = false;
		} catch (error) {
			status.textContent = error.message;
		} finally {
			button.disabled = false;
		}
	});

	document.getElementById('refresh-admin').addEventListener('click', loadAdmin);

	document.querySelectorAll('[data-admin-tab]').forEach(function (button) {
		button.addEventListener('click', function () {
			document.querySelectorAll('[data-admin-tab]').forEach(function (tab) {
				var active = tab === button;
				tab.classList.toggle('active', active);
				tab.setAttribute('aria-selected', String(active));
			});
			state.adminTab = button.dataset.adminTab;
			renderAdminContent();
		});
	});

	document.getElementById('suggest-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		var form = event.currentTarget;
		setBusy(form, true);
		formStatus(form, '');
		try {
			var data = await api('/api/suggestions', { method: 'POST', body: formObject(form) });
			formStatus(form, data.message, 'success');
			form.reset();
			window.setTimeout(function () {
				elements.suggestDialog.close();
			}, 1300);
		} catch (error) {
			formStatus(form, error.message, 'error');
		} finally {
			setBusy(form, false);
			if (window.turnstile && form.dataset.turnstileWidget) window.turnstile.reset(form.dataset.turnstileWidget);
		}
	});

	document.getElementById('report-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		var form = event.currentTarget;
		setBusy(form, true);
		formStatus(form, '');
		try {
			var data = await api('/api/reports', { method: 'POST', body: formObject(form) });
			formStatus(form, data.message, 'success');
			window.setTimeout(function () {
				elements.reportDialog.close();
			}, 1300);
		} catch (error) {
			formStatus(form, error.message, 'error');
		} finally {
			setBusy(form, false);
			if (window.turnstile && form.dataset.turnstileWidget) window.turnstile.reset(form.dataset.turnstileWidget);
		}
	});

	document.getElementById('confirm-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		var form = event.currentTarget;
		var data = formObject(form);
		setBusy(form, true);
		formStatus(form, '');
		try {
			var result = await api('/api/locations/' + data.location_id + '/confirm', { method: 'POST', body: data });
			formStatus(form, result.message, 'success');
			await reloadLocations();
			window.setTimeout(function () { elements.confirmDialog.close(); }, 1100);
		} catch (error) {
			formStatus(form, error.message, 'error');
		} finally {
			setBusy(form, false);
			if (window.turnstile && form.dataset.turnstileWidget) window.turnstile.reset(form.dataset.turnstileWidget);
		}
	});

	document.getElementById('admin-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		var form = event.currentTarget;
		var token = formObject(form).token;
		state.adminToken = token;
		setBusy(form, true);
		try {
			await api('/api/admin/overview', {}, true);
			sessionStorage.setItem('ffm-admin-token', token);
			elements.adminDialog.close();
			await showAdminView();
		} catch (error) {
			state.adminToken = '';
			formStatus(form, error.message, 'error');
		} finally {
			setBusy(form, false);
			if (window.turnstile && form.dataset.turnstileWidget) window.turnstile.reset(form.dataset.turnstileWidget);
		}
	});

	elements.adminContent.addEventListener('click', async function (event) {
		var category = event.target.closest('[data-verification-category]');
		var page = event.target.closest('[data-verification-page]');
		if (category || page) {
			if (category) { state.verificationCategory = category.dataset.verificationCategory; state.verificationPage = 1; }
			if (page) state.verificationPage = Number(page.dataset.verificationPage);
			await loadAdmin();
			return;
		}
		var reviewButton = event.target.closest('[data-review-suggestion]');
		if (reviewButton) {
			var suggestion = state.admin.suggestions.find(function (item) {
				return Number(item.id) === Number(reviewButton.dataset.reviewSuggestion);
			});
			if (suggestion) openReviewDialog(suggestion, 'suggestion');
			return;
		}
		var editButton = event.target.closest('[data-edit-location]');
		if (editButton) {
			var location = state.admin.locations.find(function (item) {
				return Number(item.id) === Number(editButton.dataset.editLocation);
			});
			try {
				if (!location) { var response = await api('/api/admin/locations/' + editButton.dataset.editLocation, {}, true); location = response.location; }
				if (location) openReviewDialog(location, 'location');
			} catch (error) { showToast(error.message); }
			return;
		}
		var verifyButton = event.target.closest('[data-run-verification]');
		if (verifyButton) {
			try {
				await api('/api/admin/locations/' + verifyButton.dataset.runVerification + '/verify', { method: 'POST', body: {} }, true);
				showToast('Source verification queued.');
				await loadAdmin();
			} catch (error) { showToast(error.message); }
			return;
		}
		var rejectButton = event.target.closest('[data-reject-suggestion]');
		if (rejectButton) {
			if (!window.confirm('Reject this suggestion?')) return;
			try {
				await api(
					'/api/admin/suggestions/' + rejectButton.dataset.rejectSuggestion + '/reject',
					{ method: 'POST', body: { review_notes: '' } },
					true,
				);
				showToast('Suggestion rejected.');
				await loadAdmin();
			} catch (error) {
				showToast(error.message);
			}
			return;
		}
		var resolveButton = event.target.closest('[data-resolve-report]');
		if (resolveButton) {
			var report = state.admin.reports.find(function (item) {
				return Number(item.id) === Number(resolveButton.dataset.resolveReport);
			});
			var form = document.getElementById('resolve-form');
			form.reset();
			form.elements.id.value = report.id;
			document.getElementById('resolve-copy').textContent = report.location_name + ': ' + report.description;
			formStatus(form, '');
			elements.resolveDialog.showModal();
		}
	});

	document.getElementById('review-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		var form = event.currentTarget;
		var data = formObject(form);
		var mode = data.mode;
		var id = data.id;
		delete data.mode;
		delete data.id;
		setBusy(form, true);
		formStatus(form, '');
		try {
			if (mode === 'suggestion') {
				await api('/api/admin/suggestions/' + id + '/approve', { method: 'POST', body: data }, true);
				showToast('Suggestion approved and published.');
			} else {
				await api('/api/admin/locations/' + id, { method: 'PUT', body: data }, true);
				showToast('Location updated.');
			}
			elements.reviewDialog.close();
			await loadAdmin();
			await reloadLocations();
		} catch (error) {
			formStatus(form, error.message, 'error');
		} finally {
			setBusy(form, false);
			if (window.turnstile && form.dataset.turnstileWidget) window.turnstile.reset(form.dataset.turnstileWidget);
		}
	});

	document.getElementById('resolve-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		var form = event.currentTarget;
		var data = formObject(form);
		setBusy(form, true);
		try {
			await api('/api/admin/reports/' + data.id + '/resolve', { method: 'POST', body: { resolution_notes: data.resolution_notes } }, true);
			elements.resolveDialog.close();
			showToast('Report resolved.');
			await loadAdmin();
		} catch (error) {
			formStatus(form, error.message, 'error');
		} finally {
			setBusy(form, false);
			if (window.turnstile && form.dataset.turnstileWidget) window.turnstile.reset(form.dataset.turnstileWidget);
		}
	});

	window.addEventListener('online', function () {
		showToast('You are back online.');
		reloadLocations();
	});

	window.addEventListener('offline', function () {
		showToast('Offline mode: showing previously loaded information.');
	});

	window.addEventListener('hashchange', routeFromHash);

	async function initialize() {
		refreshIcons();
		void loadMeta();
		void loadStats();
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker
				.register('/sw.js')
				.then(function (registration) {
					return registration.update();
				})
				.catch(function (error) {
					console.error('Service worker registration failed', error);
				});
		}
		var pageParams = new URLSearchParams(window.location.search);
		var linkedZip = pageParams.get('zip');
		if (/^\d{5}$/.test(linkedZip || '')) document.getElementById('search-zip').value = linkedZip;
		routeFromHash();
		if (window.location.hash === '#map' && linkedZip) loadLocations();
		if (pageParams.get('share-url') || pageParams.get('suggest') === '1') {
			var form = document.getElementById('suggest-form');
			form.reset();
			if (pageParams.get('share-url')) form.elements.source_url.value = pageParams.get('share-url');
			formStatus(form, '');
			elements.suggestDialog.showModal();
		}
	}

	initialize();
})();
