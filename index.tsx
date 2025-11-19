// FIX: Add declaration for the Leaflet.js global to resolve "Cannot find name 'L'" errors.
declare const L: any;

import { GoogleGenAI, Type } from "@google/genai";

// --- CONSTANTS & CONFIG ---
const INITIAL_MONEY = 5000;
const COST_PER_KM = 0.25;

const GameState = {
    STARTING: "Select a Starting City",
    LANDING_QUIZ: "City Quiz",
    SELECT_JOB: "Find a Job",
    JOB_QUIZ: "Job Trial",
    TRAVEL_PLANNING: "Plan Your Next Trip",
    GAME_OVER: "Game Over",
    VICTORY: "You Win!",
};

const STARTING_CITIES = [
    { city: 'New York', country: 'USA', latitude: 40.7128, longitude: -74.0060 },
    { city: 'London', country: 'UK', latitude: 51.5074, longitude: -0.1278 },
    { city: 'Tokyo', country: 'Japan', latitude: 35.6895, longitude: 139.6917 },
    { city: 'Sydney', country: 'Australia', latitude: -33.8688, longitude: 151.2093 },
    { city: 'Linköping', country: 'Sweden', latitude: 58.4108, longitude: 15.6214 },
    { city: 'Rio de Janeiro', country: 'Brazil', latitude: -22.9068, longitude: -43.1729 },
];

// --- DOM ELEMENTS ---
const DOMElements = {
    map: document.getElementById('map'),
    panel: document.getElementById('panel'),
    money: document.getElementById('money'),
    location: document.getElementById('location'),
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    status: document.getElementById('status'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingMessage: document.getElementById('loading-message'),
    welcomeOverlay: document.getElementById('welcome-overlay'),
    startGameBtn: document.getElementById('start-game-btn'),
};

// --- GAME STATE ---
// FIX: Define a comprehensive type for the global state object to resolve property access errors.
let state: {
    journal: JournalKeeper | null;
    currentGameState: string;
    map: any;
    markers: any[];
    polylines: any[];
    agents: {
        travel?: TravelAgent;
        jobFinder?: JobFinderAgent;
        quiz?: QuizAgent;
    };
    currentQuiz: {
        title: string;
        questions: any[];
        currentIndex: number;
        score: number;
    } | null;
    selectedJob: { title: string; description: string; wikipediaSearchTerm: string; } | null;
    jobOptions: { title: string; description: string; wikipediaSearchTerm: string; }[];
    travelOptions: any[];
} = {
    journal: null,
    currentGameState: GameState.STARTING,
    map: null,
    markers: [],
    polylines: [],
    agents: {},
    currentQuiz: null,
    selectedJob: null,
    jobOptions: [],
    travelOptions: [],
};

// --- HELPER: PARSE GEMINI JSON ---
const parseGeminiJson = (text) => {
    if (!text) throw new Error("Received empty response from AI.");
    try {
        const cleanText = text.replace(/^```json\s*|```\s*$/g, '').trim();
        return JSON.parse(cleanText);
    } catch (error) {
        console.error("Failed to parse JSON from AI response:", text, error);
        throw new Error("AI returned an invalid response format.");
    }
};

// --- SERVICES ---
class GeminiService {
    // FIX: Declare class properties to resolve access errors.
    ai: GoogleGenAI;
    model: string;

    constructor() {
        // FIX: Per coding guidelines, API key must be read from process.env.API_KEY directly.
        this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        this.model = 'gemini-3-pro-preview';
    }

    async generate(prompt, responseSchema) {
        const response = await this.ai.models.generateContent({
            model: this.model,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema,
            },
        });
        return parseGeminiJson(response.text);
    }

    generateJobs(location, count = 8) {
        const prompt = `Generate ${count} realistic, common jobs for a backpacker in ${location.city}, ${location.country}. For each job, provide a 'title' (e.g., 'Museum Guide'), a brief 'description', and a 'wikipediaSearchTerm' that is a general concept, activity, or institution highly likely to have a Wikipedia page (e.g., for 'Dog Walker', the term could be 'Dog walking'; for 'Driver', it could be 'Uber').`;
        return this.generate(prompt, { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, description: { type: Type.STRING }, wikipediaSearchTerm: { type: Type.STRING } }, required: ["title", "description", "wikipediaSearchTerm"] } });
    }

    generateQuiz(context, topic) {
        const prompt = `Based on the provided text about "${topic}", generate 10 interesting, high-school level multiple choice questions. The questions should focus on significant facts such as history, geography, culture, or important landmarks. Avoid obscure trivia or pop culture references (like films or TV shows) unless they are of major historical or cultural significance. The "answer" field MUST exactly match one of the strings from the "options" array. Each question must have 4 options. Crucially, the quiz taker will not see the provided text, so all questions must be self-contained and should not refer to the text in any way (e.g., do not use phrases like 'in the text' or 'as mentioned in the article'). Provided text: "${context}"`;
        return this.generate(prompt, { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { question: { type: Type.STRING }, options: { type: Type.ARRAY, items: { type: Type.STRING } }, answer: { type: Type.STRING } }, required: ["question", "options", "answer"] } });
    }
    
    generateDestinations(location) {
        return this.generate(`From ${location.city}, ${location.country}, suggest 8 diverse travel destinations (capitals or major hubs) for a backpacker. Provide 2 cities to the North, 2 South, 2 East, and 2 West.`, { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { city: { type: Type.STRING }, country: { type: Type.STRING }, latitude: { type: Type.NUMBER }, longitude: { type: Type.NUMBER } }, required: ["city", "country", "latitude", "longitude"] } });
    }
}

class WikipediaService {
    async fetchArticleContent(query) {
        // Fetch the full article content from Wikipedia.
        const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=true&format=json&origin=*&redirects=1&titles=${encodeURIComponent(query)}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            const pages = data.query.pages;
            const page = Object.values(pages)[0] as any;
            // Return the extract or an empty string if not found.
            return page.extract || '';
        } catch (error) {
            console.error("Wikipedia fetch error:", error);
            // Return an empty string on error.
            return '';
        }
    }
}

// --- AGENTS ---
class JournalKeeper {
    // FIX: Declare class properties to resolve access errors.
    currentMoney: number;
    startLocation: any;
    currentLocation: any;
    totalLongitudeChange: number;
    visitedLocations: any[];
    jobHistory: any[];

    constructor(startingMoney, startLocation) {
        this.currentMoney = startingMoney;
        this.startLocation = startLocation;
        this.currentLocation = startLocation;
        this.totalLongitudeChange = 0;
        this.visitedLocations = [startLocation];
        this.jobHistory = [];
    }

    updateMoney(amount) { this.currentMoney += amount; }
    
    updateLocation(newLocation, oldLocation) {
        this.currentLocation = newLocation;
        let delta = newLocation.longitude - oldLocation.longitude;
        if (delta > 180) delta -= 360;
        else if (delta < -180) delta += 360;
        this.totalLongitudeChange += delta;
        this.visitedLocations.push(newLocation);
    }
    
    hasWon() {
        const isAtStart = this.currentLocation.city === this.startLocation.city;
        const hasCircumnavigated = Math.abs(this.totalLongitudeChange) >= 360;
        return isAtStart && hasCircumnavigated && this.visitedLocations.length > 1;
    }
}

class TravelAgent {
    // FIX: Declare class property to resolve access error.
    geminiService: GeminiService;
    constructor(geminiService) { this.geminiService = geminiService; }
    
    async getTravelOptions(currentLocation) {
        const destinations = await this.geminiService.generateDestinations(currentLocation);
        return destinations.map(dest => {
            const distance = this.calculateDistance(currentLocation, dest);
            const mode = distance > 2000 ? 'Plane' : (distance > 500 ? 'Train' : 'Bus');
            return { ...dest, cost: Math.round(distance * COST_PER_KM), mode };
        });
    }

    calculateDistance(loc1, loc2) {
        const R = 6371;
        const dLat = (loc2.latitude - loc1.latitude) * Math.PI / 180;
        const dLon = (loc2.longitude - loc1.longitude) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(loc1.latitude * Math.PI / 180) * Math.cos(loc2.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }
}

class JobFinderAgent {
    // FIX: Declare class properties to resolve access errors.
    geminiService: GeminiService;
    wikiService: WikipediaService;
    constructor(geminiService, wikiService) {
        this.geminiService = geminiService;
        this.wikiService = wikiService;
    }

    async findJobs(location) {
        const validJobs = [];
        let attempts = 0;
        const MAX_ATTEMPTS = 3;

        while (validJobs.length < 5 && attempts < MAX_ATTEMPTS) {
            attempts++;
            const potentialJobs = await this.geminiService.generateJobs(location, 8);
            
            const validationResults = await Promise.all(
                potentialJobs.map(async (job) => {
                    const context = await this.wikiService.fetchArticleContent(job.wikipediaSearchTerm);
                    return { job, isValid: !!context };
                })
            );

            for (const { job, isValid } of validationResults) {
                if (isValid && validJobs.length < 5 && !validJobs.some(j => j.title === job.title)) {
                    validJobs.push(job);
                }
            }
        }
        return validJobs;
    }
}

class QuizAgent {
    // FIX: Declare class properties to resolve access errors.
    geminiService: GeminiService;
    wikiService: WikipediaService;
    constructor(geminiService, wikiService) {
        this.geminiService = geminiService;
        this.wikiService = wikiService;
    }
    
    async generateQuiz(context, topic) {
        const questions = await this.geminiService.generateQuiz(context, topic);
        return Array.isArray(questions) ? questions.filter(q => q && q.question && Array.isArray(q.options) && q.options.length > 1 && q.answer && q.options.includes(q.answer)) : [];
    }
    
    async generateLocationQuiz(location) {
        const context = await this.wikiService.fetchArticleContent(`${location.city}, ${location.country}`);
        if (!context) return [];
        return this.generateQuiz(context, `${location.city}, ${location.country}`);
    }
    
    async generateJobQuiz(job) {
        const context = await this.wikiService.fetchArticleContent(job.wikipediaSearchTerm);
        if (!context) return [];
        return this.generateQuiz(context, job.title);
    }
}


// --- UI RENDERING ---
function renderDashboard() {
    if (!state.journal) return;
    DOMElements.money.textContent = `$${state.journal.currentMoney.toLocaleString()}`;
    DOMElements.location.textContent = `${state.journal.currentLocation.city}, ${state.journal.currentLocation.country}`;
    const progress = Math.min((Math.abs(state.journal.totalLongitudeChange) / 360) * 100, 100);
    DOMElements.progressBar.style.width = `${progress}%`;
    DOMElements.progressText.textContent = `${Math.round(Math.abs(state.journal.totalLongitudeChange))}°/360°`;
    DOMElements.status.textContent = state.currentGameState;
}

function renderPanel() {
    DOMElements.panel.innerHTML = '';
    let content = '';

    switch (state.currentGameState) {
        case GameState.STARTING:
            content = `
                <h2 class="panel-title">Choose Your Starting City</h2>
                <p class="panel-description">Your journey begins now. Where in the world will you start?</p>
                <div class="item-list">
                    ${STARTING_CITIES.map((city, index) => `
                        <button class="item-button" data-action="select-city" data-index="${index}">
                            <h3 class="item-title">${city.city}</h3>
                            <p class="item-subtitle">${city.country}</p>
                        </button>
                    `).join('')}
                </div>`;
            break;
        case GameState.LANDING_QUIZ:
        case GameState.JOB_QUIZ:
            if(state.currentQuiz) {
                const q = state.currentQuiz.questions[state.currentQuiz.currentIndex];
                content = `
                    <h2 class="panel-title">${state.currentQuiz.title}</h2>
                    <p class="panel-description">Question ${state.currentQuiz.currentIndex + 1} of ${state.currentQuiz.questions.length} | Score: ${state.currentQuiz.score * 100}</p>
                    <p class="quiz-question">${q.question}</p>
                    <div class="item-list">
                        ${q.options.map(opt => `<button class="item-button quiz-option" data-action="answer-quiz" data-answer="${opt}">${opt}</button>`).join('')}
                    </div>`;
            }
            break;
        case GameState.SELECT_JOB:
            content = `
                <h2 class="panel-title">Find a Job</h2>
                <p class="panel-description">Time to earn some cash. Choose a job to take on a trial. You get $100 for each correct answer.</p>
                <div class="item-list">
                    ${state.jobOptions.map((job, i) => `
                        <button class="item-button" data-action="select-job" data-index="${i}">
                            <h3 class="item-title">${job.title}</h3>
                            <p class="item-description">${job.description}</p>
                        </button>
                    `).join('')}
                </div>`;
            break;
        case GameState.TRAVEL_PLANNING:
            content = `
                <h2 class="panel-title">Where to next?</h2>
                <p class="panel-description">The world is waiting. Choose your next destination.</p>
                <div class="item-list">
                    ${state.travelOptions.map((opt, i) => `
                        <button class="item-button" data-action="select-destination" data-index="${i}" ${state.journal.currentMoney < opt.cost ? 'disabled' : ''}>
                            <div class="item-details">
                                <div>
                                    <h3 class="item-title">${opt.city}, ${opt.country}</h3>
                                    <p class="item-subtitle">${opt.mode}</p>
                                </div>
                                <span class="item-cost">$${opt.cost.toLocaleString()}</span>
                            </div>
                        </button>
                    `).join('')}
                </div>`;
            break;
        case GameState.GAME_OVER:
            content = `
                <div class="final-screen">
                    <h2 class="panel-title">Game Over</h2>
                    <p class="panel-description">You've run out of money or have no affordable travel options. Better luck next time!</p>
                    <button class="action-button" data-action="restart">Start a New Journey</button>
                </div>`;
            break;
        case GameState.VICTORY:
            content = `
                <div class="final-screen">
                    <h2 class="panel-title">Congratulations!</h2>
                    <p class="panel-description">You've successfully circumnavigated the globe and returned home. You are a true Vibe Code Backpacker!</p>
                    <button class="action-button" data-action="restart">Play Again</button>
                </div>`;
            break;
    }
    DOMElements.panel.innerHTML = content;
}

// --- MAP LOGIC ---
function initMap() {
    state.map = L.map(DOMElements.map).setView([20, 0], 2.5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(state.map);
}

function addMarkerToMap(location) {
    const marker = L.circleMarker([location.latitude, location.longitude], {
        radius: 8,
        fillColor: "#ef4444",
        color: "#fff",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
    }).addTo(state.map);
    state.markers.push(marker);
}

function flyToLocation(location, zoom = 5) {
    state.map.flyTo([location.latitude, location.longitude], zoom, { duration: 2 });
}

function drawPath(from, to) {
    const latlngs = [[from.latitude, from.longitude], [to.latitude, to.longitude]];
    const polyline = L.polyline(latlngs, { color: 'red', weight: 2 }).addTo(state.map);
    state.polylines.push(polyline);
}

function resetMap() {
    state.markers.forEach(m => m.remove());
    state.polylines.forEach(p => p.remove());
    state.markers = [];
    state.polylines = [];
    flyToLocation({latitude: 20, longitude: 0}, 2.5);
}

// --- GAME FLOW ---
function showLoading(message) {
    DOMElements.loadingMessage.textContent = message;
    DOMElements.loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
    DOMElements.loadingOverlay.classList.add('hidden');
}

async function updateGameState(newState) {
    state.currentGameState = newState;
    renderDashboard();
    renderPanel();

    try {
        switch (newState) {
            case GameState.LANDING_QUIZ:
                showLoading(`Generating quiz for ${state.journal.currentLocation.city}...`);
                const locQuiz = await state.agents.quiz.generateLocationQuiz(state.journal.currentLocation);
                if (locQuiz.length > 0) {
                    state.currentQuiz = { title: `Welcome to ${state.journal.currentLocation.city}!`, questions: locQuiz, currentIndex: 0, score: 0 };
                } else {
                    return updateGameState(GameState.SELECT_JOB);
                }
                break;
            case GameState.SELECT_JOB:
                showLoading(`Finding jobs in ${state.journal.currentLocation.city}...`);
                state.jobOptions = await state.agents.jobFinder.findJobs(state.journal.currentLocation);
                if (state.jobOptions.length === 0) {
                    return updateGameState(GameState.TRAVEL_PLANNING);
                }
                break;
            case GameState.JOB_QUIZ:
                 showLoading(`Preparing your job trial for ${state.selectedJob.title}...`);
                 const jobQuiz = await state.agents.quiz.generateJobQuiz(state.selectedJob);
                 if (jobQuiz.length > 0) {
                     state.currentQuiz = { title: `Job Trial: ${state.selectedJob.title}`, questions: jobQuiz, currentIndex: 0, score: 0 };
                 } else {
                     state.journal.updateMoney(100); // Pity payment
                     return updateGameState(GameState.TRAVEL_PLANNING);
                 }
                break;
            case GameState.TRAVEL_PLANNING:
                showLoading('Finding routes to your next destination...');
                state.travelOptions = await state.agents.travel.getTravelOptions(state.journal.currentLocation);
                if (state.travelOptions.length === 0 || !state.travelOptions.some(o => state.journal.currentMoney >= o.cost)) {
                    return updateGameState(GameState.GAME_OVER);
                }
                break;
        }
    } catch (error) {
        console.error("Error during game state transition:", error);
        // Fallback to a safe state
        if (state.currentGameState.includes('Quiz') || state.currentGameState === GameState.SELECT_JOB) {
            updateGameState(GameState.TRAVEL_PLANNING);
        } else {
            updateGameState(GameState.GAME_OVER);
        }
    } finally {
        hideLoading();
        renderPanel();
    }
}

function handleQuizAnswer(answer) {
    const quiz = state.currentQuiz;
    const question = quiz.questions[quiz.currentIndex];
    const isCorrect = answer === question.answer;
    
    if (isCorrect) quiz.score++;

    // Visual feedback
    // FIX: Cast NodeListOf<Element> to NodeListOf<HTMLButtonElement> to access properties like 'disabled' and 'dataset'.
    const buttons = DOMElements.panel.querySelectorAll<HTMLButtonElement>('.quiz-option');
    buttons.forEach(btn => {
        btn.disabled = true;
        btn.classList.add('disabled');
        const btnAnswer = btn.dataset.answer;
        if (btnAnswer === question.answer) btn.classList.add('correct');
        else if (btnAnswer === answer) btn.classList.add('incorrect');
    });

    setTimeout(() => {
        if (quiz.currentIndex < quiz.questions.length - 1) {
            quiz.currentIndex++;
            renderPanel();
        } else { // Quiz complete
            const earnings = quiz.score * 100;
            state.journal.updateMoney(earnings);
            state.currentQuiz = null;
            if (state.currentGameState === GameState.JOB_QUIZ) {
                updateGameState(GameState.TRAVEL_PLANNING);
            } else {
                updateGameState(GameState.SELECT_JOB);
            }
        }
    }, 1500);
}

// --- EVENT HANDLERS ---
function handlePanelClick(e) {
    // FIX: Cast target to HTMLButtonElement to access dataset properties.
    const button = e.target.closest('button[data-action]') as HTMLButtonElement;
    if (!button) return;

    const { action, index, answer } = button.dataset;

    switch (action) {
        case 'select-city':
            const startLocation = STARTING_CITIES[index];
            state.journal = new JournalKeeper(INITIAL_MONEY, startLocation);
            addMarkerToMap(startLocation);
            flyToLocation(startLocation);
            updateGameState(GameState.LANDING_QUIZ);
            break;
        case 'answer-quiz':
            handleQuizAnswer(answer);
            break;
        case 'select-job':
            state.selectedJob = state.jobOptions[index];
            updateGameState(GameState.JOB_QUIZ);
            break;
        case 'select-destination':
            const destination = state.travelOptions[index];
            const from = state.journal.currentLocation;

            state.journal.updateMoney(-destination.cost);
            drawPath(from, destination);
            addMarkerToMap(destination);
            flyToLocation(destination, 6);

            state.journal.updateLocation(destination, from);

            if (state.journal.hasWon()) {
                updateGameState(GameState.VICTORY);
            } else if (state.journal.currentMoney <= 0) {
                updateGameState(GameState.GAME_OVER);
            } else {
                updateGameState(GameState.LANDING_QUIZ);
            }
            break;
        case 'restart':
            state.journal = null;
            resetMap();
            updateGameState(GameState.STARTING);
            break;
    }
}

// --- INITIALIZATION ---
function initialize() {
    // FIX: Check for process.env.API_KEY directly as per guidelines.
    if (!process.env.API_KEY) {
        showLoading("Gemini API Key is missing.\nPlease configure it to start the application.");
        return;
    }

    // FIX: Instantiate GeminiService without passing the key. The service will handle it.
    const geminiService = new GeminiService();
    const wikiService = new WikipediaService();
    state.agents = {
        travel: new TravelAgent(geminiService),
        jobFinder: new JobFinderAgent(geminiService, wikiService),
        quiz: new QuizAgent(geminiService, wikiService),
    };
    
    initMap();
    DOMElements.panel.addEventListener('click', handlePanelClick);

    DOMElements.startGameBtn.addEventListener('click', () => {
        DOMElements.welcomeOverlay.classList.add('hidden');
        updateGameState(GameState.STARTING);

        // Add a one-time shimmer effect to the starting city buttons to guide the user.
        setTimeout(() => {
            const cityButtons = DOMElements.panel.querySelectorAll('button[data-action="select-city"]');
            cityButtons.forEach(btn => {
                btn.classList.add('shimmer-effect');
            });
        }, 100); // Short delay to allow the panel to render.
    });
}

document.addEventListener('DOMContentLoaded', initialize);