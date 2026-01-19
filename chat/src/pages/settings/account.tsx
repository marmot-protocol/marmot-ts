import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CreateProfile, UpdateProfile } from "applesauce-actions/actions";
import { use$ } from "applesauce-react/hooks";
import ISO6391 from "iso-639-1";
import { useEffect, useState } from "react";
import { actions, user$ } from "../../lib/accounts";
import { EventStatusButton } from "@/components/event-status-button";
import { PageBody } from "../../components/page-body";
import { PageHeader } from "../../components/page-header";

export default function SettingsAccountPage() {
  const profile = use$(user$.profile$);

  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState("");
  const [website, setWebsite] = useState("");
  const [languages, setLanguages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useComboboxAnchor();

  // Initialize form state from profile
  useEffect(() => {
    if (profile) {
      console.log("Profile:", profile);
      setName(profile.name ?? "");
      setAbout(profile.about ?? "");
      setPicture(profile.picture ?? "");
      setWebsite(profile.website ?? "");
      setLanguages(profile.languages ?? []);
    }
  }, [profile]);

  // Get all language options
  const languageOptions = ISO6391.getAllCodes().map((code) => ({
    code,
    name: ISO6391.getName(code),
  }));

  // Filter languages based on search
  const [languageSearch, setLanguageSearch] = useState("");
  const filteredLanguages = languageOptions.filter(
    (lang) =>
      lang.name.toLowerCase().includes(languageSearch.toLowerCase()) ||
      lang.code.toLowerCase().includes(languageSearch.toLowerCase()),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await actions.run(profile ? UpdateProfile : CreateProfile, {
        name: name || undefined,
        about: about || undefined,
        picture: picture || undefined,
        website: website || undefined,
        languages: languages.length > 0 ? languages : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    if (profile) {
      setName(profile.name ?? "");
      setAbout(profile.about ?? "");
      setPicture(profile.picture ?? "");
      setWebsite(profile.website ?? "");
      setLanguages(profile.languages ?? []);
    }
    setError(null);
  };

  return (
    <>
      <PageHeader
        items={[
          { label: "Home", to: "/" },
          { label: "Settings", to: "/settings" },
          { label: "Account" },
        ]}
        actions={profile?.event && <EventStatusButton event={profile.event} />}
      />
      <PageBody>
        <form onSubmit={handleSubmit} className="space-y-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="profile-name">Name</FieldLabel>
              <Input
                id="profile-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="profile-about">About</FieldLabel>
              <Textarea
                id="profile-about"
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder="Tell us about yourself"
                rows={4}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="profile-picture">Picture URL</FieldLabel>
              <Input
                id="profile-picture"
                type="url"
                value={picture}
                onChange={(e) => setPicture(e.target.value)}
                placeholder="https://example.com/picture.jpg"
              />
              <FieldDescription>
                Enter a URL to your profile picture
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="profile-website">Website</FieldLabel>
              <Input
                id="profile-website"
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
              <FieldDescription>
                Enter your personal or professional website URL
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="profile-languages">Languages</FieldLabel>
              <div className="space-y-2">
                {languages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {languages.map((code) => {
                      const lang = languageOptions.find((l) => l.code === code);
                      return (
                        <Badge
                          key={code}
                          variant="secondary"
                          className="cursor-pointer"
                          onClick={() =>
                            setLanguages(languages.filter((c) => c !== code))
                          }
                        >
                          {lang ? lang.name : code}
                          <span className="ml-1">×</span>
                        </Badge>
                      );
                    })}
                  </div>
                )}
                <div ref={anchor}>
                  <Combobox
                    items={filteredLanguages}
                    value={null}
                    onValueChange={(value) => {
                      if (value && !languages.includes(value)) {
                        setLanguages([...languages, value]);
                        setLanguageSearch("");
                      }
                    }}
                  >
                    <ComboboxInput
                      placeholder="Search and add languages..."
                      value={languageSearch}
                      onChange={(e) => setLanguageSearch(e.target.value)}
                    />
                    <ComboboxContent anchor={anchor}>
                      <ComboboxEmpty>No languages found.</ComboboxEmpty>
                      <ComboboxList>
                        {(item) => (
                          <ComboboxItem
                            key={item.code}
                            value={item.code}
                            disabled={languages.includes(item.code)}
                          >
                            {item.name} ({item.code})
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                </div>
              </div>
              <FieldDescription>
                Select the languages you speak (you can select multiple)
              </FieldDescription>
            </Field>

            {error && <div className="text-destructive text-sm">{error}</div>}

            <Field orientation="horizontal">
              <Button type="submit" disabled={loading}>
                {loading ? "Saving..." : "Save Changes"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleReset}
                disabled={loading}
              >
                Reset
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </PageBody>
    </>
  );
}
